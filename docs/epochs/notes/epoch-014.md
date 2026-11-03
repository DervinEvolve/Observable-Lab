# Epoch 14: Changing ONLY total_steps_estimate from 5000 to 4100 (keeping min_lr_ratio=0.1, max_lr=1.2

- **Author:** Grok
- **Verdict:** KEEP (run: ok)
- **val_bpb:** 0.7067 (Δ vs best-at-time: -0.0090)

## Hypothesis
Changing ONLY total_steps_estimate from 5000 to 4100 (keeping min_lr_ratio=0.1, max_lr=1.2e-3, warmup=100 unchanged) will cut val_bpb below 0.7156 because matching the cosine horizon to the actual ~4100-step budget lets the schedule reach its intended min_lr floor instead of stopping at ~30% decay.

## Change
Single-line surgical edit: total_steps_estimate changed from 5000 to 4100 in train() (line ~180). No other schedule params, architecture, or logic touched. Exactly isolates the horizon-alignment hypothesis requested by Planner.

## Review
The run completed cleanly and improved val_bpb from the current best 0.7156 to 0.70666 with essentially unchanged model size and VRAM: 10.720M params, 3191 MB, 4335 steps in 300.06s. The change isolated total_steps_estimate=4100 while keeping max_lr, warmup, min_lr_ratio, architecture, and training logic fixed, so the gain is attributable enough to keep. Challenger's variance warning is real, but the ~0.009 bpb improvement is larger than the cited likely noise band and there is no cheating or evaluation taint.

## Challenger concerns
- Epoch 13 already tested total_steps_estimate=4100 but with min_lr_ratio=0.01 (compound change). The Planner correctly isolated horizon this epoch, but the result (0.7067) is nearly identical to epoch 13's 0.7071 — within noise. This strongly suggests min_lr_ratio=0.01 contributed nothing and the entire gain came from horizon alignment alone. However, we cannot rule out that epoch 13's revert was an error if the panel objected to compounding but the number was real.
- Run-to-run variance not characterized. We have no repeated-measure baseline to distinguish a 0.009 bpb improvement from noise. The model is small (10.7M params) and trained for only ~4300 steps — initialization seed, batch ordering, and CUDA nondeterminism could easily produce ±0.003-0.005 bpb swings.
- The hypothesis states 'matching the cosine horizon to the actual ~4100-step budget lets the schedule reach its intended min_lr floor instead of stopping at ~30% decay.' But with total_steps_estimate=5000 and min_lr_ratio=0.1, the LR at step 4335 would be: progress = (4335-100)/(5000-100) = 0.864, cos_coeff = 0.5*(1+cos(π*0.864)) = 0.5*(1-0.907) = 0.0465, LR = 0.1*1.2e-3 + 0.0465*0.9*1.2e-3 = 1.2e-4 + 5.02e-5 = 1.70e-4. With horizon=4100: progress = (4335-100)/(4100-100) = 1.0 (clamped), cos_coeff = 0, LR = min_lr = 1.2e-4. The difference is only 1.70e-4 vs 1.20e-4 — a 30% reduction in final LR, not 'stopping at 30% decay.' The narrative overstates the mechanism.
- The eval uses max_batches=200 with eval_batch_size=32 (6400 tokens per batch, 1.28M tokens total). This is only ~0.9% of the 142M training tokens seen. While this matches the established harness, the eval coverage is thin — a lucky/unlucky draw of eval batches could swing bpb by 0.002-0.005.

*Ledger: results.tsv, epoch 14.*
