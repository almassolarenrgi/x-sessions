import {
  Abi,
  Account,
  AccountInterface,
  Call,
  CallData,
  InvocationsDetails,
  InvocationsSignerDetails,
  InvokeFunctionResponse,
  ProviderInterface,
  ProviderOptions,
  Signature,
  SignerInterface,
  TransactionType,
  UniversalDetails,
  num,
  stark,
} from "starknet"
import { ensureArray } from "./ensureArray"
import { OffchainSessionCall } from "./interface"

const OFFCHAIN_SESSION_ENTRYPOINT = "use_offchain_session"

export class OffchainSessionAccountV5
  extends Account
  implements AccountInterface
{
  constructor(
    providerOrOptions: ProviderOptions | ProviderInterface,
    address: string,
    pkOrSigner: Uint8Array | string | SignerInterface,
    public sessionSignature: Signature,
    public account: AccountInterface,
  ) {
    super(providerOrOptions, address, pkOrSigner, "1")
  }

  private async sessionToCall(
    dappSignature: Signature,
  ): Promise<OffchainSessionCall> {
    const signature = stark.formatSignature(this.sessionSignature)
    const formattedDappSignature = stark.formatSignature(dappSignature)

    return {
      contractAddress: this.address,
      entrypoint: OFFCHAIN_SESSION_ENTRYPOINT,
      calldata: CallData.compile({
        signer: await this.signer.getPubKey(),
        token1: formattedDappSignature[0],
        token2: formattedDappSignature[1],
        // owner
        token3: signature[0],
        token4: signature[1],
        // cosigner
        token5: signature[2],
        token6: signature[3],
      }),
    }
  }

  private async extendCallsBySession(
    calls: Call[],
    dappSignature: Signature,
  ): Promise<OffchainSessionCall[]> {
    const sessionCall = await this.sessionToCall(dappSignature)
    return [sessionCall, ...calls]
  }

  /**
   * Invoke execute function in account contract
   *
   * [Reference](https://github.com/starkware-libs/cairo-lang/blob/f464ec4797361b6be8989e36e02ec690e74ef285/src/starkware/starknet/services/api/gateway/gateway_client.py#L13-L17)
   *
   * @param calls - one or more calls to be executed
   * @param abis - one or more abis which can be used to display the calls
   * @param transactionsDetail - optional transaction details
   * @returns a confirmation of invoking a function on the starknet contract
   */
  public async execute(
    calls: Call | Call[],
    abiOrDetails?: Abi[] | UniversalDetails,
    transactionsDetail: InvocationsDetails = {},
  ): Promise<InvokeFunctionResponse> {
    const transactions = ensureArray(calls)

    const version = "0x1" as const
    const chainId = await this.getChainId()

    const details =
      abiOrDetails === undefined || Array.isArray(abiOrDetails)
        ? transactionsDetail
        : abiOrDetails

    const nonce = num.toHex(details.nonce ?? (await this.getNonce()))

    let maxFee = details.maxFee

    if (!maxFee) {
      try {
        const sim = await this.simulateTransaction(
          [
            {
              type: TransactionType.INVOKE,
              payload: calls,
            },
          ],
          {
            skipValidate: true,
            nonce,
          },
        )

        const [estimation] = sim
        const { fee_estimation } = estimation
        const overall_fee = fee_estimation.overall_fee
        maxFee = estimation.suggestedMaxFee ?? overall_fee
      } catch (e) {
        // fallback
        maxFee = (
          await this.getSuggestedFee(
            {
              type: TransactionType.INVOKE,
              payload: calls,
            },
            {
              skipValidate: true,
              nonce,
            },
          )
        ).suggestedMaxFee
      }
    }

    const signerDetails: InvocationsSignerDetails = {
      walletAddress: this.account.address,
      nonce,
      maxFee,
      version,
      chainId,
      cairoVersion: this.cairoVersion ?? "1",
    }

    const dappSignature = await this.signer.signTransaction(
      transactions,
      signerDetails,
    )

    const transactionsWithSession = await this.extendCallsBySession(
      transactions,
      dappSignature,
    )

    /*  
      need to use the same values for transactionDetails (nonce, maxFee, version)
      otherwise the cosign would fail most of the times 
      since maxFee could change in a very short time if calculated in both this package and in webwallet
    */
    return this.account?.execute(transactionsWithSession, {
      nonce,
      maxFee: maxFee.toString(),
      version,
    })
  }
}
