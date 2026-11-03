# Epoch 17: Raising max_lr from 1.2e-3 to 2.4e-3 (with total_steps_estimate=4100, min_lr_ratio=0.1, wa

- **Author:** Claude
- **Verdict:** REVERT (run: ok)
- **val_bpb:** 0.7348 (Δ vs best-at-time: 0.0281)

## Hypothesis
Raising max_lr from 1.2e-3 to 2.4e-3 (with total_steps_estimate=4100, min_lr_ratio=0.1, warmup=100 fixed) will reduce val_bpb below 0.7067 by letting the model exploit the full capacity of the SwiGLU+RMSNorm stack before the aligned cosine decay begins.

## Change
Single-line change: max_lr raised from 1.2e-3 to 2.4e-3 (line now reads `max_lr = 2.4e-3`, with an epoch-17 comment). warmup_steps=100, total_steps_estimate=4100, min_lr_ratio=0.1 (default in lr_at_step), batch size, seq_len, and architecture are all untouched. This is the exact isolated LR-scale test the Planner specified.

## Review
The measured val_bpb of 0.7348 is a clear regression from the current best 0.7067. The 2x increase in max_lr to 2.4e-3 destabilized training, yielding a loss far above the baseline, confirming that the original 1.2e-3 is near the stability limit for this architecture and optimizer setup. The experiment was isolated and ran without technical issues, so the result is trustworthy.

## Challenger concerns
- The edit cleanly tests a 2x global LR-scale increase, but it does not isolate 'higher peak LR before decay' from the also-doubled warmup slope and doubled cosine floor.
- The result is far worse than the current best, so variance is unlikely to explain the direction, but the exact magnitude should not be overinterpreted.
- No signs of metric gaming, eval tampering, val leakage, or budget abuse are visible. The 300.06s runtime is consistent with the scaffold's one-step loop granularity.

*Ledger: results.tsv, epoch 17.*
