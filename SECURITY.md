# Security reports

Please report Observable-Lab vulnerabilities privately to this repository's maintainer.

If GitHub offers **Report a vulnerability** in this repository's Security tab, use that form. If it is unavailable, ask the maintainer for a private contact route without including the vulnerability, credentials, or exploit details in a public issue.

This is an experimental project. There is no promised response time or supported production security boundary.

Never include provider credentials, database URLs, runner tokens, or private experiment content in an issue, screenshot, or pull request. Revoke exposed credentials through the relevant provider; removing a file from the latest commit does not remove it from Git history.

## Model proposals are never merged automatically

When `LAB_ENABLE_LAB_PROPOSALS` is on, a model may propose a change to this repository. The lab opens it as a pull request labelled `model-proposal` and stops there. There is no merge call in that code path, and its token (`LAB_PROPOSALS_GITHUB_TOKEN`) is a separate fine-grained token for this one repository with Pull requests and Contents permissions only, so it cannot change repository settings, workflow files, secrets or other repositories. The lab only ever writes to `model-proposal/...` branches with it; protect the default branch so that a merge always needs the owner, whatever the token could do.

Only the owner merges these, by hand, because this repository is not like AI-Agent:

- **It deploys to production.** A merge to the deployed branch becomes the live site and API on the next deployment, with no CI gate in between that could judge whether generated code is safe.
- **Its server holds the lab's credentials.** The API functions run with the OpenRouter key, the database URL, the GitHub tokens, the Sprites token, the Modal tokens and the operator and cron secrets. Code merged here runs next to all of them, so a single bad or manipulated proposal could leak them or spend without limit.
- **It is the lab's own control surface.** It decides what the models can do, the spending cap, what the room shows as evidence and what counts as tested. A model must not be able to change those rules for itself.

AI-Agent contributions and exhibits can merge on their own because that repository holds no credentials, deploys nothing, and its changes are limited to source, tests, docs and exhibit data, behind its own required CI checks.

Treat a `model-proposal` pull request as untrusted outside input: read the whole diff, and do not run it with real credentials before you have.

## Conversations visitors offer

When `LAB_ENABLE_VISITOR_OFFERS` is on, a visitor can offer a chat with a trained model to the lab, and only then is that conversation stored (text, the model, and the UTC day; no address, browser string or account). Each reply the chat gives carries a receipt, an HMAC-SHA-256 over the adapter, the day and the conversation so far, so an offer can only hold replies the lab's own endpoint gave, in order. The receipt key is derived from `LAB_OPERATOR_SECRET`, or from `CRON_SECRET` when that is not set, and from nothing else: a leaked database URL cannot forge a receipt, and with neither secret set offers are off. Treat those two secrets as the key to that proof. The take back code is shown once and only its hash is stored. Offered text is never public. It is read only through `POST /api/experiment/visitor-offers` with the operator secret, each read is counted in the public record, and no model reads it. The automatic checks refuse emails, long numbers, links and user names and do not find other private details or abuse. Please report anything that lets a visitor read, forge or delete another person's offer, or reach the text without the operator secret, privately as described above.
