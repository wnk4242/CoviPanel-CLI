# CoviPanel Command-line Edition

**Title and abstract screening in Covidence · Version 1.1.0**

CoviPanel supports title and abstract screening in Covidence for librarians, information specialists, and researchers conducting systematic reviews. The Windows command-line application combines artificial intelligence (AI) recommendations with researcher review, explicit submission confirmation, and a local decision history.

Launch this edition with **Start CoviPanel.cmd**. The [browser-based CoviPanel](https://github.com/wnk4242/CoviPanel) is a separate application.

## Core capabilities

- **Review-specific criteria.** Define inclusion criteria, exclusion criteria, and response instructions separately for each project.
- **Review before submission.** Prepare recommendations for a batch, inspect abstracts, and confirm any decision or rationale changes. AI Yes and Maybe records appear first, followed by No records.
- **Auditable records.** Retain original AI responses separately from researcher edits and submission records, and export decisions and rationales to Excel.
- **Session continuity.** Resume compatible pending batches using saved responses, with uncertain submissions retained for investigation.

## Screening workflow

1. Select a Covidence review, then save its eligibility criteria and model settings.
2. Specify a batch size and prepare AI recommendations for researcher review.
3. Inspect the records and revise decisions or rationales where necessary.
4. Press **S** to save decisions locally or **C** to request submission of the entire batch.

Both actions include unchanged and unvisited records and require **y/yes + Enter** confirmation. **Esc/Enter** preserves a pending batch for later review and submission. Records saved with **S** are excluded from subsequent screening batches. Confirmed **X** cancellation deletes eligible unsubmitted responses and edits without creating a response backup.

## Study history search

Version 1.1 adds **7. Search study history**, which retrieves a record by its exact Covidence study number, such as `#123`. Researchers can inspect available original AI responses and recorded vote status, then confirm local decision or rationale corrections. These corrections update the applicable Excel history sheets without changing original AI responses, recorded online votes, or pending batch decisions. These operations use local records and do not request AI recommendations or submit votes.

## Installation

Windows, **Node.js 22.13 or newer**, Covidence access, and an OpenAI API key are required.

1. Run **Set Up This Computer.cmd** to install dependencies and Chromium.
2. Enter your own API key in `Setups/Settings/.env` before preparing recommendations.
3. Run **Start CoviPanel.cmd**, create a project, and sign in to Covidence when prompted.
4. Save the eligibility criteria and model settings before starting the screening workflow.

Fictional examples are available in [examples/demo](examples/demo/README.md) for demonstration purposes.

## Research use and data handling

AI recommendations require researcher assessment against the review protocol. Screening performance should be evaluated for each review. The application sends study information and screening instructions to the OpenAI API, and new recommendations may incur charges. Manage credentials, browser sessions, and research records according to institutional requirements.
