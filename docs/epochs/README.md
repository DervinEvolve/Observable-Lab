# The early Observable Lab run

These are the saved notes for epochs 1–20. An epoch is one round of proposals, a test and a review. I kept the original findings notes, and made the available role-by-role conversations easier to read.

## Start here

- [Epochs 13](notes/epoch-013.md) and [14](notes/epoch-014.md): the group asks for a clearer test after two settings changed together.
- [Epoch 14's challenger concerns](notes/epoch-014.md#challenger-concerns): an agent checks the learning-rate explanation against the actual calculation.
- [Epoch 15](notes/epoch-015.md): the deeper model completes fewer training steps within the time limit.
- [Epoch 17 conversation](transcripts/epoch-017.md): the challenger asks the group to describe exactly which learning-rate settings changed.
- [Epoch 19 conversation](transcripts/epoch-019.md): the smaller batch produces more updates and a worse reported score; the challenger raises a schedule mismatch.
- [Epoch 20 conversation](transcripts/epoch-020.md): the training program fails to parse, and the recorded conversation ends after the Reviewer.

## Reading the results

The score is `val_bpb`, or validation bits per byte. It measures how well the model predicts test text. Lower is better. The training programs calculate these scores themselves. Independent evaluation and repeat runs are still planned.

Dataset descriptions change around epochs 5–6. The later notes explicitly describe TinyStories; the older experiment description refers to enwik8. Early ledger rows have empty dataset and harness-version fields. Comparisons need the same dataset and evaluation setup.

The original notes include strong claims from the agents, including claims of statistical significance. Those statements belong to the recorded discussion. A repeated-run study is still needed to establish the size and reliability of an effect.

The `Author` field in each saved note identifies the agent that supplied the training code. The role transcripts include each participant's remark, proposed test, objections and recorded notes.

## Epoch index

There is one index entry per epoch number. Notes are available for all twenty rounds. Turn-by-turn outputs are available for epochs 16–20; epoch 20 is partial.

| Epoch | Test | Reported score | Recorded decision | Conversation |
| --- | --- | ---: | --- | --- |
| [1](notes/epoch-001.md) | Try RMSNorm on the early setup | 6.8969 | reverted | saved note |
| [2](notes/epoch-002.md) | Shorten the training schedule | 7.0622 | reverted | saved note |
| [3](notes/epoch-003.md) | Lengthen the training schedule | 7.9424 | reverted | saved note |
| [4](notes/epoch-004.md) | Increase the learning rate | 6.5712 | kept | saved note |
| [5](notes/epoch-005.md) | Investigate a surprising score | 0.7315 | reverted | saved note |
| [6](notes/epoch-006.md) | Try another learning rate on TinyStories | 0.7234 | reverted | saved note |
| [7](notes/epoch-007.md) | Try RMSNorm on TinyStories | 0.7223 | kept | saved note |
| [8](notes/epoch-008.md) | Change text length and batch size | 0.7773 | reverted | saved note |
| [9](notes/epoch-009.md) | Try a different model building block | 0.7156 | kept | saved note |
| [10](notes/epoch-010.md) | Try rotary position information | unavailable | training failed | saved note |
| [11](notes/epoch-011.md) | Lengthen the schedule again | 0.7357 | reverted | saved note |
| [12](notes/epoch-012.md) | Shorten the schedule toward the observed run | unavailable | training failed | saved note |
| [13](notes/epoch-013.md) | Change two schedule settings together | 0.7071 | reverted | saved note |
| [14](notes/epoch-014.md) | Test the schedule length by itself | 0.7067 | kept | saved note |
| [15](notes/epoch-015.md) | Use a deeper model | 0.7213 | reverted | saved note |
| [16](notes/epoch-016.md) | Lower the final learning rate | 0.7153 | reverted | [Read](transcripts/epoch-016.md) |
| [17](notes/epoch-017.md) | Double the learning-rate scale | 0.7348 | reverted | [Read](transcripts/epoch-017.md) |
| [18](notes/epoch-018.md) | Increase the training batch | 0.7197 | reverted | [Read](transcripts/epoch-018.md) |
| [19](notes/epoch-019.md) | Reduce the training batch | 0.7255 | reverted | [Read](transcripts/epoch-019.md) |
| [20](notes/epoch-020.md) | Try lower weight decay; training crashes | unavailable | training failed | [Read](transcripts/epoch-020.md) (partial) |

## A quirk in the ledger

The [original results file](results-original.tsv) contains 2,322 rows. 2,303 carry epoch number 20. The index groups them under that one round. The source file is preserved unchanged.

The resume code can reuse a saved training result and write another ledger row before later narration finishes. This allows a later interruption to produce another entry for the same result. The saved epoch-20 training error is a Python syntax error. I may have run out of provider credits during the later interruptions. I still need to check the provider records and model availability before the next run.

## Words used in the notes

- **Batch:** the group of training examples used for one update.
- **Learning rate:** the size of the model's weight updates.
- **Schedule or horizon:** how those update sizes change over the course of training.
- **Baseline:** the earlier setup a proposed change is compared with.
- **Keep / revert:** the group's decision to retain or reject the proposed code change.
- **Crash:** a failed program run with an unavailable prediction score.

## Source record

The findings notes and ledger come from the Research-Lab revision `938bfce294803b2ba811167b8077dbca91d9b61d`. The role outputs were read from Observable Lab's public experiment-state API. [The source manifest](source-manifest.json) records the original file identifiers and checksums. [role-outputs.json](role-outputs.json) preserves the exported turn data.

The archive generator runs offline:

```sh
python3 scripts/build-epoch-archive.py
```

I'm planning a fresh run soon with updated models. I'll keep this early run here so the proposals, reviews and failures remain available alongside the new work.
