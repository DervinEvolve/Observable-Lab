# Epoch 19: Reducing micro-batch size from 64 to 48 while keeping seq_len=512, max_lr=1.2e-3, warmup=1

- **Author:** DeepSeek-V4
- **Verdict:** REVERT (run: ok)
- **val_bpb:** 0.7255 (Δ vs best-at-time: 0.0188)

## Hypothesis
Reducing micro-batch size from 64 to 48 while keeping seq_len=512, max_lr=1.2e-3, warmup=100, total_steps_estimate=4100, min_lr_ratio=0.1, and architecture fixed will reduce val_bpb below 0.7067 because the 300s regime is update-limited and more optimizer steps will outweigh the noisier gradients and modestly lower tokens_seen.

## Change
In the non-smoke branch of train(), changed batch_size from 64 to 48. All other hyperparameters (seq_len=512, max_lr=1.2e-3, warmup=100, total_steps_estimate=4100, min_lr_ratio=0.1, architecture) remain identical. No other modifications.

## Review
Measured val_bpb=0.7255 vs current best 0.7067 (clear regression). 5741 steps were taken but performance degraded; hypothesis falsified. Static total_steps_estimate=4100 now mismatches the higher step count, and batch/token confounding prevents clean attribution.

## Challenger concerns
- Severe schedule mismatch / learning rate starvation due to static total_steps_estimate
- Confounding of batch size and total token throughput

*Ledger: results.tsv, epoch 19.*
