# Epoch 8: Reducing sequence length from 512 to 256 and increasing batch size from 64 to 128 (keeping

- **Author:** GPT-5
- **Verdict:** REVERT (run: ok)
- **val_bpb:** 0.7773 (Δ vs best-at-time: 0.0550)

## Hypothesis
Reducing sequence length from 512 to 256 and increasing batch size from 64 to 128 (keeping tokens per step constant) will increase training steps per second under the 300s budget, leading to >200 extra gradient updates and lowering val_bpb below 0.7200.

## Change
In the non-smoke training configuration inside train(args), seq_len is changed from 512 to 256 and batch_size from 64 to 128, preserving 32,768 tokens per optimizer step. Smoke settings, architecture, optimizer, LR schedule, evaluation harness call, and RESULT contract are otherwise unchanged. Evaluation uses the same seq_len variable as training, so this faithfully tests the shorter-context model end to end.

## Review
Measured val_bpb rose from 0.7223 to 0.7773 despite 4257 vs 4164 steps; the shorter 256-token context produced a genuinely weaker model whose extra gradient updates could not compensate. No measurement artifact or cheating is present per the Challenger note. The hypothesis is conclusively falsified.

## Challenger concerns
- The result is REAL and clearly worse — no confound. Shortening seq_len to 256 halves the model's max context, so eval bpb (0.7773 vs 0.7223) reflects a genuinely weaker model, not a measurement artifact. The extra steps (4257 vs 4164) failed to compensate for the lost context.

*Ledger: results.tsv, epoch 8.*
