# Third-party materials

The root MIT license applies to original contributions by Dervin Dimanche. It does not relicense dependencies, models, datasets, trademarks, or other third-party materials. Keep their own copyright notices and license files when redistributing them.

## Scene assets

- The human characters are from Quaternius's [Ultimate Animated Character Pack](https://quaternius.com/packs/ultimatedanimatedcharacter.html), offered under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). The character files use the pack's Female_Dress, Female_TankTop, Female_Alternative, Male_Casual, and Male_LongSleeve names.
- `public/models/scientists/code/Robot.gltf` is the animated robot from Quaternius's [Animated Robot Pack](https://quaternius.com/packs/animatedrobot.html), CC0 1.0. Its RobotArmature/Robot_* animation names match the creator's October 2018 Robot.fbx archive. A copy of the archive's license is in `docs/licenses/quaternius-animated-robot.txt`.
- The spaceship named Spaceship_BarbaraTheBee is from Quaternius's [Ultimate Space Kit](https://quaternius.com/packs/ultimatespacekit.html), CC0 1.0.
- The subagent drone in `src/entities/Drone.ts` uses original procedural geometry. The former imported `public/models/drone/drone.glb` has been removed from this draft because its source could not be established. The old drone and historical MachineMan/GLM asset must also be removed from the published history unless their redistribution terms can be confirmed. The root MIT license does not cover those old assets.

No model-provider logos are included. The interface names providers in plain text (Google, DeepSeek, Anthropic, OpenAI, xAI, Z.ai, Cohere); those names are their owners' trademarks and are used only to say which provider serves a model, without implying endorsement. The logo images used earlier (`public/logos/`) were removed because their sources could not be confirmed.

The three still captures in `docs/assets/` show the current app with text provider labels. The earlier composed figures, which contained an unconfirmed provider avatar and the old imported drone, are excluded from this snapshot. The room GIF is a labelled local simulation, not a recording of connected model or sandbox activity.

## Software and research

Dependencies retain the licenses shipped in their packages. The lockfile records the resolved versions; it is not a substitute for their notices. [GSAP](https://gsap.com/) (`gsap` 3.14.2), which is bundled into the built frontend, is under GreenSock's [standard "no charge" license](https://gsap.com/standard-license), not an OSI-approved open-source license; its terms apply to anyone redistributing the built frontend. The research loop is influenced by [karpathy/autoresearch](https://github.com/karpathy/autoresearch). This is a separate experiment, not an upstream project or endorsed implementation.

The legacy Modal code (`modal/app.py`, `modal/finetune.py`) downloads `Qwen/Qwen2.5-3B` from Hugging Face when it runs. Those weights are not bundled here and are under their own model license, which must be checked before use or redistribution of the weights or of fine-tuned checkpoints.

Dataset permissions must be checked separately for each configured research dataset. A reference to enwik8 or TinyStories does not grant permission to redistribute training data or derived checkpoints. No model or dataset license is replaced by this repository's MIT license.

The bundled `modal/harness/prepare.py` originated in DervinEvolve/Research-Lab at blob `c33f69057b59a9a9785a2ec77715cb47f2ea1412`. Changed here since: a provenance header, and a dataset revision pin with a SHA-256 check. It downloads [karpathy/tinystories-gpt4-clean](https://huggingface.co/datasets/karpathy/tinystories-gpt4-clean), a cleaned GPT-4 subset of TinyStories by Eldan and Li. The dataset metadata declares [CDLA-Sharing-1.0](https://cdla.dev/sharing-1-0/). No dataset is bundled in this source repository; keep the dataset terms separate from the MIT code license and review them before redistributing data.

## README figure composition

An optional renderer derived from [Benji Taylor’s Stageshow](https://github.com/benjitaylor/skills/tree/main/stageshow), under MIT, is preserved with its notice in [docs/readme-visual](docs/readme-visual/README.md). The README uses the plain app captures and the separately recorded simulation GIF.
