import {
  Account,
  Call,
  RpcProvider,
  V2InvocationsSignerDetails,
  ec,
  stark,
} from "starknet"
import { StarknetChainId, TypedDataRevision } from "starknet-types"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { ArgentBackendSessionService } from "../sessionBackendService"
import { SessionDappService } from "../sessionDappService"

const allowedMethodContractAddress = stark.randomAddress()

const cacheAuthorisation = false
const sessionRequest = {
  expires_at: 1234567890,
  allowed_methods: [
    {
      "Contract Address": allowedMethodContractAddress,
      selector: "some_method",
    },
  ],
  metadata: JSON.stringify({
    projectID: "test",
    txFees: [
      { tokenAddress: stark.randomAddress(), maxAmount: "1000000000000" },
    ],
  }),
  session_key_guid:
    "0x116dcea0b31d06f721c156324cd8de3652bf8953cd5ba055f74db21b1134ec9",
}
const sessionAuthorizationSignature = ["signature1", "signature2"]

describe("SessionDappService", () => {
  let argentBackend: ArgentBackendSessionService
  let chainId: StarknetChainId
  let privateDappKey: Uint8Array
  let publicDappKey: string
  let sessionDappService: SessionDappService

  beforeAll(async () => {
    chainId = StarknetChainId.SN_GOERLI
    privateDappKey = ec.starkCurve.utils.randomPrivateKey()
    publicDappKey = ec.starkCurve.getStarkKey(privateDappKey)
    argentBackend = new ArgentBackendSessionService(
      publicDappKey,
      sessionAuthorizationSignature,
    )

    vi.spyOn(argentBackend, "signTxAndSession").mockImplementation(
      async () => ({
        publicKey: "0x123",
        r: 10n,
        s: 10n,
      }),
    )

    sessionDappService = new SessionDappService(argentBackend, chainId, {
      privateKey: privateDappKey,
      publicKey: publicDappKey,
    })
  })

  it("should get an account with session signer", async () => {
    const provider = new RpcProvider()
    const address = stark.randomAddress()

    const account = sessionDappService.getAccountWithSessionSigner(
      provider,
      address,
      sessionRequest,
      sessionAuthorizationSignature,
      cacheAuthorisation,
    )

    expect(account).toBeInstanceOf(Account)
  })

  it("should signTransaction calling argent backend", async () => {
    const invokationDetails: V2InvocationsSignerDetails = {
      cairoVersion: "1",
      chainId,
      maxFee: 1000n,
      nonce: 1,
      version: "0x2",
      walletAddress: stark.randomAddress(),
    }

    const signatureResult: any = await (
      sessionDappService as any
    ).signTransaction(
      sessionAuthorizationSignature,
      sessionRequest,
      [],
      invokationDetails,
      cacheAuthorisation,
    )

    expect(signatureResult).toBeInstanceOf(Array)
    expect(argentBackend.signTxAndSession).toHaveBeenCalled()
    expect(argentBackend.signTxAndSession).toReturnWith({
      publicKey: "0x123",
      r: 10n,
      s: 10n,
    })
  })

  it("should get an outside execution call with execute_from_outside", async () => {
    const provider = new RpcProvider()
    vi.spyOn(provider, "getChainId").mockImplementation(
      async () => StarknetChainId.SN_SEPOLIA,
    )
    const address = stark.randomAddress()
    const revision = TypedDataRevision.Legacy
    const caller = "0x123"
    const execute_after = 1
    const execute_before = 999999999999999
    const nonce = 0
    const calls: Call[] = [
      {
        contractAddress: allowedMethodContractAddress,
        entrypoint: "some_method",
        calldata: ["0x123"],
      },
    ]

    // TODO
    vi.spyOn(argentBackend, "signOutsideTxAndSession").mockImplementation(
      async () => ({
        publicKey: "0x123",
        r: 10n,
        s: 10n,
      }),
    )

    const outsideExecutionCall =
      await sessionDappService.getOutsideExecutionCall(
        sessionRequest,
        sessionAuthorizationSignature,
        cacheAuthorisation,
        calls,
        revision,
        address,
        provider,
        caller,
        execute_after,
        execute_before,
        nonce,
      )

    expect(outsideExecutionCall.entrypoint).toEqual("execute_from_outside")
    expect(outsideExecutionCall.contractAddress).toEqual(address)
    expect(outsideExecutionCall.calldata).toBeInstanceOf(Array)
    expect(outsideExecutionCall.calldata).not.toBe([])
  })

  it("should get an outside execution call with execute_from_outside_v2", async () => {
    const provider = new RpcProvider()
    vi.spyOn(provider, "getChainId").mockImplementation(
      async () => StarknetChainId.SN_SEPOLIA,
    )
    const address = stark.randomAddress()
    const revision = TypedDataRevision.Active
    const caller = "0x123"
    const execute_after = 1
    const execute_before = 999999999999999
    const nonce = 0
    const calls: Call[] = [
      {
        contractAddress: allowedMethodContractAddress,
        entrypoint: "some_method",
        calldata: ["0x123"],
      },
    ]

    // TODO
    vi.spyOn(argentBackend, "signOutsideTxAndSession").mockImplementation(
      async () => ({
        publicKey: "0x123",
        r: 10n,
        s: 10n,
      }),
    )

    const outsideExecutionCall =
      await sessionDappService.getOutsideExecutionCall(
        sessionRequest,
        sessionAuthorizationSignature,
        cacheAuthorisation,
        calls,
        revision,
        address,
        provider,
        caller,
        execute_after,
        execute_before,
        nonce,
      )

    expect(outsideExecutionCall.entrypoint).toEqual("execute_from_outside_v2")
    expect(outsideExecutionCall.contractAddress).toEqual(address)
    expect(outsideExecutionCall.calldata).toBeInstanceOf(Array)
    expect(outsideExecutionCall.calldata).not.toBe([])
  })
})
