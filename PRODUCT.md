# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Primary user:** a solo builder who builds many small products with Claude Code and Claude Desktop, such as websites, apps and customer tools. They glance at Pulse beside Claude after finishing work.
- **Second reader (confirmed 2026-10-15):** someone grading that work, such as a teacher, judge or client who isn't a coder. Every review and explanation must make sense to them: plain words, short, but with the evidence behind each claim.

## Product Purpose
Project Pulse is a local development adviser. After a Claude Code session finishes a task, or when asked, it writes a 30-second review:
- what was built
- a completion status: Completed, Partially Completed, Needs Testing, Blocked, or No Meaningful Changes
- benefits and potential drawbacks
- up to three next steps (why, benefit, drawback, priority), linked to the drawback each one fixes

It remembers each project separately, so it never repeats done or declined ideas. Success means the user understands what they just built and what to do next within about 30 seconds, without Pulse ever changing their code.

## Positioning
Pulse reviews the actual session it watched, using the same Claude conversation, and connects work to drawbacks to fixes across sessions. It advises and records; the user decides. It never writes code or sends prompts by itself.

## Operating Context
- **Where it runs:** its own window (a dedicated Edge app window, default about 460×800, resizable, often kept beside Claude), opened automatically when a review lands, after you pause typing.
- **When it's used:** glanced at between tasks, in both daytime and evening, so light and dark follow the Windows setting.
- **How it's used:**
  - "Review now"
  - recommendation cards: Explore, Ask Why, Add to Plan, Compare, Dismiss, Mark Completed, Discuss in Claude, Copy Prompt
  - Plan, History and Connections tabs, and Settings
- **Projects:** many projects, switched from the header.

## Capabilities and Constraints
- **Stack:** vanilla HTML, CSS and JS in `ui/`, served by the local Node service. No build step and no network resources: no CDNs and no web fonts, so system fonts only.
- **The window must never take keyboard focus.** No `alert`, `confirm` or `autofocus`.
- **All text from the model is escaped and never executed.**
- **"Discuss in Claude"** only places a prompt in the Claude Code prompt box, or copies it. The prompt must be detailed and accurate, and must ask Claude not to change files until the user agrees.
- **API contract:** `docs/API.md`.

## Evidence on Hand
- Real data comes from the service (`/api/projects/:id`).
- `ui/demo.js` holds synthetic sample projects for previews, and must stay labeled as demo.
- No testimonials, metrics or users to cite.

## Product Principles
1. Clear before clever: a non-coder grading the work understands every line.
2. Evidence over claims: every status and benefit says what it is based on.
3. Advise, never act: nothing changes the user's code without their go-ahead.
4. Calm at a glance: readable in about 30 seconds, easy on the eyes for long sessions, never interrupting.
5. Connected memory: show how work, problems and fixes link across sessions.

## Accessibility & Inclusion
- WCAG AA contrast in both themes.
- Never use color alone for status: always pair it with an icon and a word.
- Respect reduced motion.
- Full keyboard use, with visible focus.
