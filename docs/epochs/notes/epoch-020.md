# Epoch 20: Lowering AdamW weight_decay from 0.1 to 0.01, with the epoch-14 champion architecture, bat

- **Author:** Claude
- **Verdict:** REVERT (run: crash)
- **val_bpb:** no result (Δ vs best-at-time: n/a)
- **Score source:** none
- **Dataset:** unknown
- **Harness SHA-256:** unknown
- **Training wall time (measured by the runner):** unknown

## Hypothesis
Lowering AdamW weight_decay from 0.1 to 0.01, with the epoch-14 champion architecture, batch_size=64, seq_len=512, max_lr=1.2e-3, warmup=100, total_steps_estimate=4100, and min_lr_ratio=0.1 unchanged, will reduce val_bpb below 0.7067 because the current 300s run is fit-limited and excessive decoupled decay is damping useful weights, especially tied byte embeddings and MLP matrices.

## Change
Modified the weight_decay argument in the model.configure_optimizer call from 0.1 to 0.01 inside the train function. All other hyperparameters, model configuration, and schedule arguments remain identical to the epoch 14 champion configuration.

## Review
Run crashed with SyntaxError before any training or eval; no val_bpb was produced. Hypothesis never tested. Revert to epoch-14 champion.

## Challenger concerns
- The experiment crashed with a SyntaxError in train.py at line 382 before any training occurred. The reported error ('unterminated string literal') indicates the code edit was not syntactically valid, so the weight_decay change was never executed or measured.

*Ledger: results.tsv, epoch 20.*
