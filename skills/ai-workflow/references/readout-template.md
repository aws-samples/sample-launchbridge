<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Engagement Readout — Digest Schema

> The engagement readout is normally provided as a **PDF or Word document** by the client or
> engagement lead. The `ai-workflow` skill ingests that file and extracts its content into
> `.lb_workspace/ai_workflow/readout.md` using the structure below, which then seeds
> `.context/README.md` and the `/ai-create` descriptions.
>
> Use this schema two ways: (1) as the target structure when normalizing a provided document,
> and (2) as the question set when no document exists and you capture the readout interactively.
> Fill what the source states; leave the italic prompts for anything not covered. Do not fabricate.

## Project Background

_What is this engagement about? What does the system do, and what business problem does it solve?_

## Stakeholders & Users

_Who is the client/team? Who actually uses the system, and what are they trying to accomplish?_

## Scope — In

_What this engagement will build or change. List the major capabilities/features._

## Scope — Out

_Explicitly out of scope. Boundaries that should not be crossed._

## Inferred Features

_A bullet per feature implied by the scope — each can become an `/ai-create` folder._

- <feature>: <one-line description>

## Constraints

_Stable boundaries: compliance, security, brand, tech mandates, deadlines._

## Success Criteria

_What "done" / "working well" looks like from the client's perspective._

## Reference Projects & Reuse

_Related projects (docs and/or code) worth using as references or reuse sources._

- Source: <repo/URL or engagement name> @ <commit/version/date>
  - What to reference: <specific modules/docs>
  - Reuse rights: <internal-reusable | customer-confidential, do-not-copy | unknown — confirm>

## Key Terms

_Domain terms that must be used consistently across code and docs._
