# Epoch 18: Increasing batch_size from 64 to 96 (keeping seq_len=512, max_lr=1.2e-3, warmup=100, total

- **Author:** GPT-5
- **Verdict:** REVERT (run: ok)
- **val_bpb:** 0.7197 (Δ vs best-at-time: 0.0131)

## Hypothesis
Increasing batch_size from 64 to 96 (keeping seq_len=512, max_lr=1.2e-3, warmup=100, total_steps_estimate=4100, min_lr_ratio=0.1 fixed) will reduce val_bpb below 0.7067 because larger batches reduce gradient noise per update, and at this scale the A10G can process the bigger batch with only modest step-count loss while yielding cleaner, more stable optimization.

## Change
Changed the training batch_size from 64 to 96 inside the non-smoke branch of train(). All other architectural parameters, optimizer configurations, and schedule horizons remain identical to the champion epoch 14 configuration.

## Review
Increasing batch_size from 64 to 96 regressed validation performance, yielding 0.7197 val_bpb compared to our 0.7067 baseline. The 31.7% drop in training steps (from 4335 to 2961) starved the cosine annealing schedule, proving that update frequency is more valuable than token throughput under our strict 300-second budget.

## Challenger concerns
- Step count dropped from ~4335 (epoch 14) to 2961 — a 31.7% reduction in training steps, while tokens_seen paradoxically increased from ~142M to ~146M. The hypothesis claimed 'modest step-count loss' but the actual loss is severe. The val_bpb regression (0.7067 → 0.7197) is confounded: we cannot distinguish whether larger batches intrinsically hurt optimization or whether the step-count collapse starved the cosine schedule of its intended annealing trajectory.
- The tokens_seen metric (145.5M) is higher than epoch 14's baseline (~142M), yet val_bpb regressed. This contradicts the standard scaling-law expectation that more tokens seen = better performance. The 1.5× larger batch processed fewer parameter updates (2961 vs 4335 steps) but more total tokens — suggesting the optimizer took fewer, noisier steps on more data, which may be suboptimal for this model scale.
- VRAM increased from 3191 MB to 4620 MB (+44.8%), exceeding the 4GB soft ceiling implied by prior experiments and approaching the 14GB hard limit faster than expected. While still within bounds, this trajectory is concerning: further batch-size or model-width experiments would hit the wall quickly.
- The hypothesis asserts 'larger batches reduce gradient noise per update' — but the loss trajectory shows no evidence of reduced noise. The step-to-step loss variance in the tail (0.47–0.55 range, std ~0.018) is comparable to epoch 14's typical variance. The claimed mechanism (noise reduction) is not visibly supported by the training logs.

*Ledger: results.tsv, epoch 18.*
