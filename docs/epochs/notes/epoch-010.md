# Epoch 10: Replacing learned absolute positional embeddings (wpe) with rotary positional embeddings (

- **Author:** DeepSeek-V4
- **Verdict:** REVERT (run: crash)
- **val_bpb:** no result (Δ vs best-at-time: n/a)

## Hypothesis
Replacing learned absolute positional embeddings (wpe) with rotary positional embeddings (RoPE) applied inside attention, while keeping n_embd=384 / seq_len=512 / all other hyperparameters fixed, will reduce val_bpb below 0.7156 because RoPE provides better length generalization and removes the parameter cost of the 512	imes384 pos embedding table.

## Change
Replaced learned absolute positional embeddings (wpe) with Rotary Position Embeddings (RoPE) inside CausalSelfAttention. Removed wpe from GPT's ModuleDict and forward pass, now only token embeddings are used. Added precomputed cos/sin buffers in CausalSelfAttention and applied RoPE to queries and keys using standard rotate_half. Parameter count now excludes the former 512×384 embedding table, reducing total parameters slightly.

## Review
The training run crashed during torch.compile tracing due to an implementation compatibility bug in the RoPE shape-sensitive cos/sin buffers. Because the run failed to complete, there is no measured validation BPB, necessitating an immediate revert to our stable 0.7156 SwiGLU baseline.

## Challenger concerns
- The run crashed, so there is no measured val_bpb attributable to RoPE. This result cannot support either keeping or rejecting the positional-embedding change.
- The compile failure is likely an implementation compatibility bug rather than evidence against RoPE. RoPE adds shape-sensitive cos/sin buffers and broadcasting over q/k tensors; small mistakes can surface only inside FakeTensor tracing.
- Because learned wpe was removed at the same time RoPE was added, the experiment tests the combined mechanism: no absolute position table plus rotary q/k geometry plus ~0.2M fewer parameters. That is mostly acceptable for a RoPE swap, but attribution should be phrased narrowly.

*Ledger: results.tsv, epoch 10.*
