// The version of Reminders and what changed in each one, read by changelog.js (the chip under the logo and the What's new list).
// To release: add an entry to the top of `changelog`, set `version` to match, and raise the ?v=N on this file's <script> tag in index.html.
// Keep ONE entry per day, and each entry to ONE short, simple sentence: if today already has an entry, add to its sentence instead of a new entry.
window.__REM = {
  version: '1.1.0',
  changelog: [
    { v: '1.1.0', date: '2026-10-23', title: 'Walkthrough, new look and no notifications', items: ['Added a How do I use this? walkthrough, a changelog, the site header and footer, a new logo and a note on where reminders are saved, and removed notifications.'] },
    { v: '1.0.0', date: '', title: 'First release', items: ['An easy reminders app: type a date the way you say it, repeat, checklists, themes, search, and import or export.'] }
  ]
};
