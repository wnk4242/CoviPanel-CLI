# CoviPanel — Command-line Version

**Local Windows CMD application · Public release v1.0**

CoviPanel supports AI-assisted title and abstract screening in Covidence for librarians, information specialists, and academic researchers. This is the **local command-line version**, launched with **Start CoviPanel.cmd**. The [browser-based CoviPanel](https://github.com/wnk4242/CoviPanel) is a separate application.

## Key strengths

- **Review-specific criteria:** define inclusion criteria, exclusion criteria, and the format of AI explanations for each project.
- **Human oversight:** inspect abstracts and recommendations, edit decisions or rationales, and explicitly confirm before submission.
- **Batch preparation:** prepare recommendations together, with AI Yes and Maybe studies presented first for review.
- **Flexible completion:** submit confirmed votes through CoviPanel or save decisions locally for manual voting.
- **Traceable records:** retain original AI responses separately from human edits and submission records.
- **Continuity and exports:** resume compatible pending work, retain separate project histories, and export decisions and rationales to Excel.

## Workflow

1. **Configure:** select a Covidence review and save its screening criteria and AI settings.
2. **Prepare:** choose a batch size and generate recommendations before any voting begins.
3. **Review:** inspect studies and optionally change decisions or rationales.
4. **Complete:** press **S** to save the batch without voting, or **C** to confirm submission. Both actions cover the whole batch, including unchanged and unvisited studies, and require **y/yes + Enter**.

**Esc/Enter** leaves review pending for later. **S** finishes local review and excludes those studies from new batches. **X**, after confirmation, cancels eligible unsubmitted work and deletes its AI responses and edits without creating a response backup.

## Getting started

**Requirements:** Windows, Node.js 22.13 or newer, access to a Covidence review, and an OpenAI API key.

1. Run **Set Up This Computer.cmd** to install dependencies and Chromium.
2. Enter your own API key in `Setups/Settings/.env`.
3. Run **Start CoviPanel.cmd**, create a project, and sign in to Covidence when prompted.
4. Save your criteria and model settings, then start screening.

## Research use and privacy

AI recommendations support researcher judgement; screening accuracy must be evaluated for the intended review. Study information and screening instructions are sent to the OpenAI API, and new recommendations may incur charges. Keep credentials, browser sessions, and research records private.
