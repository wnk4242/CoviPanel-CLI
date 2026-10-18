# CoviPanel — Command-line Edition

**AI-assisted title and abstract screening for evidence synthesis · Version 1.1.0**

CoviPanel is a local Windows command-line application for librarians, information specialists, and researchers conducting systematic reviews and related evidence syntheses. It applies researcher-defined eligibility criteria to records in Covidence and presents AI recommendations for human assessment before submission. This edition runs through **Start CoviPanel.cmd**; the [browser-based CoviPanel](https://github.com/wnk4242/CoviPanel) is a separate application.

## Principal capabilities

- **Protocol-based screening.** Separate inclusion criteria, exclusion criteria, and response instructions support the requirements of each review.
- **Researcher oversight.** Abstracts, recommendations, and rationales can be examined before decisions are submitted. Decision and rationale changes require explicit confirmation.
- **Batch review.** Recommendations are prepared before voting begins. AI Yes and Maybe records appear first, followed by No records.
- **Documented decisions.** Original AI responses are retained separately from researcher edits and submission records. Decisions and rationales can be exported to Excel.
- **Flexible completion.** Researchers may submit a confirmed batch through CoviPanel or save its decisions locally for subsequent manual voting.
- **Continuity between sessions.** Compatible pending batches can be resumed using saved responses; uncertain submissions remain available for investigation.

## Screening procedure

1. Select a Covidence review and save its eligibility criteria and model settings.
2. Specify a batch size and prepare recommendations.
3. Examine the records and make any required decision or rationale revisions.
4. Select **S** to save the entire batch without voting, or **C** to open the final submission confirmation. Both actions include unchanged and unvisited records and require **y/yes + Enter**.

**Esc/Enter** leaves the review pending. Saving with **S** completes local review and excludes those records from subsequent batches. Confirmed **X** cancellation deletes eligible unsubmitted responses and edits without creating a response backup.

## Study history search — new in version 1.1

Project-menu option **7. Search study history** retrieves a record by its exact Covidence study number, such as `#123`. Researchers can inspect available source responses and recorded vote status and confirm local decision or rationale corrections. These corrections update the applicable Excel history sheets while preserving original responses, recorded online votes, and pending batch decisions. Search and local editing require no AI request or online vote.

## Installation

Windows, **Node.js 22.13 or newer**, access to the intended Covidence review, and an OpenAI API key are required.

1. Run **Set Up This Computer.cmd** to install dependencies and Chromium.
2. Configure your own API key in `Setups/Settings/.env`.
3. Run **Start CoviPanel.cmd**, create a project, and sign in to Covidence when prompted.
4. Save the screening criteria and model settings before preparing a batch.

Fictional examples are provided in [examples/demo](examples/demo/README.md).

## Research use and data handling

AI recommendations support researcher judgement; screening performance requires evaluation for the intended review. Study information and screening instructions are sent to the OpenAI API, and new recommendations may incur charges. Credentials, browser sessions, and research records should remain private and be managed according to institutional requirements.
