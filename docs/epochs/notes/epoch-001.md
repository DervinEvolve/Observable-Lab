# Epoch 1: Replacing all LayerNorm layers with RMSNorm will lower val_bpb by at least 0.1 because RMS

- **Author:** Claude
- **Verdict:** REVERT (run: ok)
- **val_bpb:** 6.8969 (Δ vs best-at-time: 0.0142)

## Hypothesis
Replacing all LayerNorm layers with RMSNorm will lower val_bpb by at least 0.1 because RMSNorm eliminates mean-centering noise in the residual stream and is empirically known to improve training stability and convergence in small transformers.

## Change
Added an RMSNorm module (last-dim RMS normalization, learnable per-channel scale, no bias, float32 internal compute for autocast stability) and replaced all three LayerNorm sites: ln_1 and ln_2 in Block, and ln_f in the GPT trunk. No other changes — same optimizer, LR schedule, batch/seq shapes, init, and time-budget loop. This drops the LayerNorm bias params and removes mean-centering exactly as the hypothesis specifies.

## Review
Run completed cleanly with no metric gaming. Measured val_bpb 6.8969 vs baseline 6.8827 (delta +0.0142), a clear regression rather than the hypothesized -0.1 improvement. Challenger correctly flags the result as negative and the bundled mechanisms as unisolated, so the change is rejected.

## Challenger concerns
- The intervention bundles multiple mechanisms: removal of mean-centering, change from variance/std normalization to RMS scaling, and removal of LayerNorm beta parameters. The result is attributable to 'RMSNorm replacement' but not specifically to the hypothesis about mean-centering noise.
- The measured delta is small: 6.8969 vs baseline 6.8827 is only +0.0142 bpb. With only one seed/run and no known baseline variance, this should not be treated as a robust negative effect size.
- No evidence of metric gaming or evaluation tampering is visible. Evaluation appears to use the standard harness, same seq_len/eval batch coverage, and the budget loop matches the scaffold.
- The run slightly exceeds the nominal training budget at 300.055s, but this matches the baseline loop pattern of checking time before each step and is unlikely to affect the result materially.

*Ledger: results.tsv, epoch 1.*
