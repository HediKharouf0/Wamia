# Feedback for 1inch (Aqua, SwapVM, SDKs)

What we ran into while building Levee on the deployed Aqua (v1.0.0) and
AquaSwapVMRouter (swap-vm v1.0.2), with a suggestion for each.

## SwapVM

1. The README describes `main`, not the deployed release.
   The router at `0x1111...0De` is v1.0.2, but the README documents `main`: the
   `swap(order, amount, takerTraitsAndData)` ABI, the opcode numbering in
   `OpcodeList.sol`, and `contracts/` paths. v1.0.2 uses
   `swap(order, tokenIn, tokenOut, amount, takerTraitsAndData)`, a jump table in
   `AquaOpcodes._opcodes()`, and `src/`. A program encoded from `main` runs the
   wrong instruction on the deployed router, with no error: `0x20` is
   `Extruction` in v1.0.2 but `Deadline` on `main`.
   Suggestion: a section per release with the deployed address, the ABI and the
   opcode indices.

2. Opcode indices have to be counted by hand.
   In v1.0.2 the dynamic array drops the first `_notInstruction` slot, so each
   index is one less than its position in the static list. We counted
   Extruction = 32 (0x20) and confirmed it with an end-to-end test.
   Suggestion: named constants next to the table.

3. The `IExtruction` ABI differs between `main` and v1.0.2.
   v1.0.2's `SwapRegisters` has a fifth field, `amountNetPulled`; `main` has
   four. An Extruction target compiled against `main` can't decode the
   registers the deployed router sends, and nothing in the docs flags it.
   Suggestion: version the interface, or call out struct changes in the release
   notes, since Extruction targets are external contracts that outlive a release.

4. Instruction args are limited to 255 bytes, and this isn't documented.
   `runLoop` reads the args length as one byte. For Extruction that leaves 235
   bytes for the target's parameters after the 20-byte address, so an
   `abi.encode`d parameter struct (288 bytes for ours) doesn't fit; we pack ours.
   v1.0.2 has no `Extruction.build` in `src/`, and the only builder
   (`ProgramBuilder`, in `test/utils`) reverts through `toUint8`.
   Suggestion: mention the limit on `Extruction`, and ship the builders in `src/`.

5. `AquaOpcodes` has no min-rate guard.
   `RequireMinRate` / `AdjustMinRate` exist in the full opcode set but not in the
   Aqua router, so every Extruction-priced Aqua strategy has to write its own
   price floor or ceiling.

6. The v1.0.2 release pins an older Aqua.
   swap-vm v1.0.2's `package.json` depends on `github:1inch/aqua#0.1.0`, while
   the deployed Aqua is tag v1.0.0. The interfaces are compatible, but it takes
   a diff to be sure.

## Aqua

7. A shipped balance is an allowance, not a reservation.
   `ship` doesn't check the wallet balance, so one wallet can back several
   strategies with the same tokens, and a `pull` fails if the wallet runs short.
   That's a feature for us (one wallet backs Levee on many markets), but it
   deserves a sentence in the README so LPs and takers know what a shipped
   balance means.

## TypeScript SDKs

8. The Aqua SDK doesn't point to the SwapVM SDK.
   `@1inch/aqua-sdk` only covers `ship`, `dock` and events, and its examples use
   the standalone `XYCSwap` Aqua app. Orders, traits, programs and
   `quote` / `swap` on the router live in `@1inch/swap-vm-sdk` (whose
   instruction table does match the deployed v1.0.2 router). We missed it at
   first because neither the Aqua SDK nor the Aqua README links to it.
   Suggestion: link the two READMEs, and show the Aqua + SwapVM router flow in
   the Aqua SDK examples.

9. `AquaProgramBuilder` has no `extruction()` method.
   The SDK's Aqua opcode table includes Extruction (index 32, matching the
   router), but the builder has no method for it, so we call
   `new AquaProgramBuilder().add(instructions.extruction.extruction.createIx(args))`.
   `RegularProgramBuilder.extruction()` exists but encodes `0x21` from its own
   table, which on the Aqua router is `OnlyTxOriginTokenBalanceNonZero`: the
   builder that has the method silently produces the wrong program. Extruction
   with empty args also throws "Invalid bytes" in the SDK, though the contract
   accepts it.
   Suggestion: add `extruction()` to `AquaProgramBuilder`.

10. The two SDKs pin different `@1inch/sdk-core` versions.
    `@1inch/aqua-sdk` 0.3.4 pins sdk-core 0.1.5 and `@1inch/swap-vm-sdk` 0.4.4
    pins 0.1.6, so npm installs two copies, and an `Address` from one isn't
    assignable to the other in TypeScript ("separate declarations of a private
    property"). The swap-vm-sdk README quick start, which passes its `Address`
    to `aqua.ship`, doesn't typecheck with the latest versions. We import
    `Address` from each SDK separately.
    Suggestion: a shared sdk-core range, or re-export one copy.
