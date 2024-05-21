import {
  Account,
  ArraySignatureType,
  BigNumberish,
  Call,
  CallData,
  InvocationsSignerDetails,
  ProviderInterface,
  RPC,
  Signer,
  TypedData,
  V2InvocationsSignerDetails,
  V3InvocationsSignerDetails,
  byteArray,
  ec,
  hash,
  merkle,
  selector,
  shortString,
  stark,
  transaction,
  typedData,
} from "starknet"
import { StarknetChainId } from "starknet-types"
import { ArgentBackendService } from "./sessionBackendService"
import {
  BackendSignatureResponse,
  DappKey,
  OffChainSession,
  OnChainSession,
  SignerType,
} from "./sessionTypes"
import { signerTypeToCustomEnum } from "./signerTypeToCustomEnum"
import { ALLOWED_METHOD_HASH, getSessionTypedData } from "./utils"

const SESSION_MAGIC = shortString.encodeShortString("session-token")

class SessionSigner extends Signer {
  constructor(
    private signTransactionCallback: (
      calls: Call[],
      invocationSignerDetails: InvocationsSignerDetails,
    ) => Promise<ArraySignatureType>,
  ) {
    super()
  }

  public async signRaw(_: string): Promise<string[]> {
    throw new Error("Method not implemented.")
  }

  public async signTransaction(
    calls: Call[],
    invocationSignerDetails: InvocationsSignerDetails,
  ): Promise<ArraySignatureType> {
    return this.signTransactionCallback(calls, invocationSignerDetails)
  }
}

export class DappService {
  constructor(
    private argentBackend: ArgentBackendService,
    public chainId: StarknetChainId,
    private dappKey: DappKey,
  ) {}

  public getAccountWithSessionSigner(
    provider: ProviderInterface,
    address: string,
    sessionRequest: OffChainSession,
    sessionAuthorizationSignature: ArraySignatureType,
    cacheAuthorisation: boolean = false,
  ) {
    const sessionSigner = new SessionSigner(
      (calls: Call[], invocationSignerDetails: InvocationsSignerDetails) => {
        return this.signTransaction(
          sessionAuthorizationSignature,
          sessionRequest,
          calls,
          invocationSignerDetails,
          cacheAuthorisation,
        )
      },
    )

    return new Account(provider, address, sessionSigner)
  }

  private async signTransaction(
    sessionAuthorizationSignature: ArraySignatureType,
    sessionRequest: OffChainSession,
    calls: Call[],
    invocationSignerDetails: InvocationsSignerDetails,
    cacheAuthorisation: boolean,
  ): Promise<ArraySignatureType> {
    const compiledCalldata = transaction.getExecuteCalldata(
      calls,
      invocationSignerDetails.cairoVersion,
    )

    let txHash
    if (
      Object.values(RPC.ETransactionVersion2).includes(
        invocationSignerDetails.version as any,
      )
    ) {
      const invocationsSignerDetailsV2 =
        invocationSignerDetails as V2InvocationsSignerDetails
      txHash = hash.calculateInvokeTransactionHash({
        ...invocationsSignerDetailsV2,
        senderAddress: invocationsSignerDetailsV2.walletAddress,
        compiledCalldata,
        version: invocationsSignerDetailsV2.version,
      })
    } else if (
      Object.values(RPC.ETransactionVersion3).includes(
        invocationSignerDetails.version as any,
      )
    ) {
      const invocationsSignerDetailsV3 =
        invocationSignerDetails as V3InvocationsSignerDetails
      txHash = hash.calculateInvokeTransactionHash({
        ...invocationsSignerDetailsV3,
        senderAddress: invocationsSignerDetailsV3.walletAddress,
        compiledCalldata,
        version: invocationsSignerDetailsV3.version,
        nonceDataAvailabilityMode: stark.intDAM(
          invocationsSignerDetailsV3.nonceDataAvailabilityMode,
        ),
        feeDataAvailabilityMode: stark.intDAM(
          invocationsSignerDetailsV3.feeDataAvailabilityMode,
        ),
      })
    } else {
      throw Error("unsupported signTransaction version")
    }
    return this.compileSessionSignature(
      sessionAuthorizationSignature,
      sessionRequest,
      txHash,
      calls,
      invocationSignerDetails.walletAddress,
      invocationSignerDetails,
      cacheAuthorisation,
    )
  }

  private async compileSessionSignature(
    sessionAuthorizationSignature: ArraySignatureType,
    sessionRequest: OffChainSession,
    transactionHash: string,
    calls: Call[],
    accountAddress: string,
    invocationSignerDetails: InvocationsSignerDetails,
    cacheAuthorisation: boolean,
  ): Promise<ArraySignatureType> {
    const session = this.compileSessionHelper(sessionRequest)
    const sessionTypedData = getSessionTypedData(sessionRequest, this.chainId)

    const sessionSignature = await this.signTxAndSession(
      transactionHash,
      accountAddress,
      sessionTypedData,
      cacheAuthorisation,
    )

    const guardianSignature = await this.argentBackend.signTxAndSession(
      calls,
      invocationSignerDetails,
      sessionTypedData,
      sessionSignature,
      cacheAuthorisation,
    )

    const sessionToken = await this.compileSessionTokenHelper(
      session,
      sessionRequest,
      calls,
      sessionSignature,
      sessionAuthorizationSignature,
      guardianSignature,
      cacheAuthorisation,
    )

    return [SESSION_MAGIC, ...CallData.compile(sessionToken)]
  }

  private async signTxAndSession(
    transactionHash: string,
    accountAddress: string,
    sessionTypedData: TypedData,
    cacheAuthorisation: boolean,
  ): Promise<bigint[]> {
    const sessionMessageHash = typedData.getMessageHash(
      sessionTypedData,
      accountAddress,
    )

    const sessionWithTxHash = hash.computePoseidonHashOnElements([
      transactionHash,
      sessionMessageHash,
      +cacheAuthorisation,
    ])

    const signature = ec.starkCurve.sign(
      sessionWithTxHash,
      this.dappKey.privateKey,
    )
    return [signature.r, signature.s]
  }

  private buildMerkleTree(sessionRequest: OffChainSession): merkle.MerkleTree {
    const leaves = sessionRequest.allowed_methods.map((method) =>
      hash.computePoseidonHashOnElements([
        ALLOWED_METHOD_HASH,
        method["Contract Address"],
        selector.getSelectorFromName(method.selector),
      ]),
    )
    return new merkle.MerkleTree(leaves, hash.computePoseidonHash)
  }

  private getSessionProofs(
    sessionRequest: OffChainSession,
    calls: Call[],
  ): string[][] {
    const tree = this.buildMerkleTree(sessionRequest)

    return calls.map((call) => {
      const allowedIndex = sessionRequest.allowed_methods.findIndex(
        (allowedMethod) => {
          return (
            allowedMethod["Contract Address"] == call.contractAddress &&
            allowedMethod.selector == call.entrypoint
          )
        },
      )
      return tree.getProof(tree.leaves[allowedIndex], tree.leaves)
    })
  }

  private compileSessionHelper(
    sessionRequest: OffChainSession,
  ): OnChainSession {
    const bArray = byteArray.byteArrayFromString(
      sessionRequest.metadata as string,
    )
    const elements = [
      bArray.data.length,
      ...bArray.data,
      bArray.pending_word,
      bArray.pending_word_len,
    ]
    const metadataHash = hash.computePoseidonHashOnElements(elements)

    const session = {
      expires_at: sessionRequest.expires_at,
      allowed_methods_root:
        this.buildMerkleTree(sessionRequest).root.toString(),
      metadata_hash: metadataHash,
      session_key_guid: sessionRequest.session_key_guid,
    }
    return session
  }

  private async compileSessionTokenHelper(
    session: OnChainSession,
    sessionRequest: OffChainSession,
    calls: Call[],
    sessionSignature: bigint[],
    session_authorization: string[],
    guardianSignature: BackendSignatureResponse,
    cache_authorization: boolean,
  ) {
    return {
      session,
      cache_authorization,
      session_authorization,
      sessionSignature: this.getStarknetSignatureType(
        this.dappKey.publicKey,
        sessionSignature,
      ),
      guardianSignature: this.getStarknetSignatureType(
        guardianSignature.publicKey,
        [guardianSignature.r, guardianSignature.s],
      ),
      proofs: this.getSessionProofs(sessionRequest, calls),
    }
  }

  // function needed as starknetSignatureType is already compiled
  private getStarknetSignatureType(pubkey: BigNumberish, signature: bigint[]) {
    return signerTypeToCustomEnum(SignerType.Starknet, {
      pubkey,
      r: signature[0],
      s: signature[1],
    })
  }

  // TODO: keep for future developments

  /* public async getOutsideExecutionCall(
    sessionRequest: OffChainSession,
    sessionAuthorizationSignature: ArraySignatureType,
    calls: Call[],
    revision: TypedDataRevision,
    accountAddress: string,
    caller = "ANY_CALLER",
    execute_after = 1,
    execute_before = 999999999999999,
    nonce = randomStarknetKeyPair().publicKey,
  ): Promise<Call> {
    const outsideExecution = {
      caller,
      nonce,
      execute_after,
      execute_before,
      calls: calls.map((call) => getOutsideCall(call)),
    }

    const currentTypedData = getTypedData(
      outsideExecution,
      await provider.getChainId(),
      revision,
    )
    const messageHash = typedData.getMessageHash(
      currentTypedData,
      accountAddress,
    )
    const signature = await this.compileSessionSignatureFromOutside(
      sessionAuthorizationSignature,
      sessionRequest,
      messageHash,
      calls,
      accountAddress,
      revision,
      outsideExecution,
    )

    return {
      contractAddress: accountAddress,
      entrypoint:
        revision == typedData.TypedDataRevision.Active
          ? "execute_from_outside_v2"
          : "execute_from_outside",
      calldata: CallData.compile({ ...outsideExecution, signature }),
    }
  } 
  
  private async compileSessionSignatureFromOutside(
    sessionAuthorizationSignature: ArraySignatureType,
    sessionRequest: OffChainSession,
    transactionHash: string,
    calls: Call[],
    accountAddress: string,
    revision: TypedDataRevision,
    outsideExecution: OutsideExecution,
  ): Promise<ArraySignatureType> {
    const session = this.compileSessionHelper(sessionRequest)

    const guardianSignature = await this.argentBackend.signOutsideTxAndSession(
      calls,
      sessionRequest,
      accountAddress,
      outsideExecution as OutsideExecution,
      revision,
    )

    const sessionSignature = await this.signTxAndSession(
      sessionRequest,
      transactionHash,
      accountAddress,
    )
    const sessionToken = await this.compileSessionTokenHelper(
      session,
      sessionRequest,
      calls,
      sessionSignature,
      sessionAuthorizationSignature,
      guardianSignature,
      accountAddress,
    )

    return [SESSION_MAGIC, ...CallData.compile(sessionToken)]
  } */
}