# Feedback for 1inch (Aqua, SwapVM, SDK)

Things we ran into while building Levee on the deployed Aqua (v1.0.0) and
AquaSwapVMRouter (swap-vm v1.0.2). Each item says what happened and what would
have helped. We add to this file as we go.

## SwapVM

1. The README describes `main`, not the deployed release.
   The router at `0x1111...0De` is v1.0.2, but the README documents `main`: the
   `swap(order, amount, takerTraitsAndData)` ABI, the banked opcode numbering in
   `OpcodeList.sol`, and `contracts/` paths. v1.0.2 uses
   `swap(order, tokenIn, tokenOut, amount, takerTraitsAndData)`, a jump table in
   `AquaOpcodes._opcodes()`, and `src/`. A program encoded from `main` runs the
   wrong instruction on the deployed router without any error: `0x20` is
   `Extruction` in v1.0.2 but `Deadline` on `main`.
   Suggestion: a per-release section in the README with the deployed address,
   ABI, and a table of opcode indices (or exported constants in `AquaOpcodes`).

2. Opcode indices have to be counted by hand.
   In v1.0.2 the dynamic array drops the first `_notInstruction` slot, so each
   index is one less than its position in the static list. We counted
   Extruction = 32 (0x20) and confirmed it with an end-to-end test.
   Suggestion: named constants next to the table.

3. The `IExtruction` ABI differs between `main` and v1.0.2.
   v1.0.2's `SwapRegisters` has a fifth field, `amountNetPulled`; `main` has
   four. An Extruction target compiled against `main` cannot decode the
   registers sent by the deployed router. Nothing in the docs flags this.
   Suggestion: version the interface, or call out struct changes in release
   notes, since Extruction targets are external contracts that outlive a release.

4. Instruction args are limited to 255 bytes, and this isn't documented.
   `runLoop` reads the args length as one byte. For Extruction that leaves
   235 bytes for the target's parameters after the 20-byte address, so an
   `abi.encode`d parameter struct (288 bytes for ours) does not fit. v1.0.2
   has no `Extruction.build` in `src/`; the only builder (`ProgramBuilder`,
   in `test/utils`) does revert via `toUint8`.
   Suggestion: mention the limit on `Extruction`, and ship the builders in `src/`.

5. `AquaOpcodes` has no min-rate guard.
   `RequireMinRate` / `AdjustMinRate` exist in the full opcode set but not in
   the Aqua router, so every Extruction-priced Aqua strategy has to reimplement
   its own price floor or ceiling.

6. The v1.0.2 release pins an older Aqua.
   `package.json` in swap-vm v1.0.2 depends on `github:1inch/aqua#0.1.0`,
   while the deployed Aqua is tag v1.0.0. The interfaces are compatible, but it
   takes a diff to be sure.

## Aqua

7. Virtual balances can promise the same tokens more than once.
   `ship` does not check the wallet balance, so one wallet can back several
   strategies with the same SY, and a `pull` fails if the wallet runs short.
   This is a feature for us (one wallet backs many markets), but it deserves a
   sentence in the README so LPs and takers know a shipped balance is an
   allowance, not a reservation.

## TypeScript SDKs

8. The Aqua SDK does not point to the SwapVM SDK.
   `@1inch/aqua-sdk` only covers `ship`, `dock` and events, and its examples use
   the standalone `XYCSwap` Aqua app. Orders, traits, programs and
   `quote` / `swap` on the router live in a separate package,
   `@1inch/swap-vm-sdk` (whose instruction table does match the deployed
   v1.0.2 router). We missed it at first because nothing in the Aqua SDK or the
   Aqua README links to it.
   Suggestion: link the two READMEs, and show the Aqua + SwapVM router flow in
   the Aqua SDK examples.

9. `AquaProgramBuilder` has no `extruction()` method.
   The Aqua opcode table in the SDK does include Extruction (index 32, matching
   the router), but the Aqua builder exposes no method for it. We had to call
   `new AquaProgramBuilder().add(instructions.extruction.extruction.createIx(args))`.
   `RegularProgramBuilder.extruction()` exists, but it encodes opcode `0x21`
   (its own table); on the Aqua router `0x21` is
   `OnlyTxOriginTokenBalanceNonZero`, so reaching for the builder that has the
   method silently produces the wrong program. Also, Extruction with empty
   args throws "Invalid bytes" in the SDK, though the contract accepts it.
   Suggestion: add `extruction()` to `AquaProgramBuilder`.

10. The two SDKs pin different `@1inch/sdk-core` versions.
    `@1inch/aqua-sdk` 0.3.4 pins sdk-core 0.1.5 and `@1inch/swap-vm-sdk` 0.4.4
    pins 0.1.6, so npm installs two copies and an `Address` from one package
    is not assignable to the other in TypeScript ("separate declarations of a
    private property"). The swap-vm-sdk README quick start, which passes its
    `Address` into `aqua.ship`, does not typecheck with the latest versions.
    We import `Address` from each SDK separately. Suggestion: a shared
    sdk-core range, or re-export one copy.
