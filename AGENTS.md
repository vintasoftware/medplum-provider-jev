# Agent notes

Gotchas only. Structure, commands and setup: [README.md](README.md). The self-hosted model on Modal: [SELF-HOSTING.md](SELF-HOSTING.md). Why the design is what it is: [ARTICLE.md](ARTICLE.md). Videos: [videos/README.md](videos/README.md).

All data here is synthetic. Keep document text, secrets and model response bodies out of logs, error messages and command output.

## Medplum

- The CLI session expires within minutes to hours. Run `npx --prefix provider medplum whoami` before any Medplum step, and ask the user to log in when it fails.
- The e2e tests need a **Practitioner** login. When the default CLI login is a ClientApplication, run them with `E2E_MEDPLUM_PROFILE=<practitioner profile>` and pass `-p <profile>` to other CLI calls.
- Project secrets take effect without a Bot redeploy; a change to `provider/bots/` needs `npm --prefix provider run deploy:bot`.
- Change project secrets with a JSON patch that starts with a `test` op on the current value. Write the patch file to the scratchpad with `umask 077`, delete it afterwards, and print secret names only. Put `CONSISTENCY_BACKEND` back to `typesafe` after any Modal test.

## e2e tests

- `E2E_RECORD=1` overwrites the committed cassettes, which hold hosted Jev's answers. After recording against Modal, copy the cassettes to `artifacts/` and restore the committed ones by writing `git show HEAD:<file>` over each file.
- Replay never runs the Bot, so it cannot test a Bot change; the Bot's unit tests and a recording run do.
- Recorder errors surface at test teardown, after the page assertions. Read the full Playwright output of a failed recording before retrying it.
- `MedplumClient` retries a failed fetch at once, up to twice. Aborting a routed Bot request therefore runs the Bot again.
- The guided demo seeds dates relative to today (the discharge summary is 7 days old). Keep fixture note text free of dates. `measure-cases.json` pins its own dates, so `measure` cannot catch a date mismatch in the live demo.

## Modal

- Stage with `HUGGING_FACE_TOKEN` set; deploy with `env -u HUGGING_FACE_TOKEN modal deploy -m demo.modal_app`, so the token stays out of the app.
- Every container costs money. During GPU work, keep a watchdog listing `modal container list` for the **exact** app name every minute. Stop a container only after the 5-minute scale-down window, or Modal replaces it. After a billing error, retry.
- A cold start begins only when a request reaches the proxy, which answers 503 at once and queues nothing. Poll `/health` every 2 s. Weight loading usually takes about a minute, and once took 14.
- `modal app logs <app>` prints earlier containers' lines too and exits instead of following. Match on the current container before trusting a line.
- Size the GPU and RAM from measurements (`nvidia-smi`, process RSS) of the settled model; headroom is billed.
- The Jebadiah server is pinned third-party code that sees document text: read the diff before changing `SERVER_COMMIT`. It refuses more than 20 options per question and prompts over 4,096 tokens.

## Local tooling

- A command-guard hook blocks `rm -rf`, `git checkout -- <path>` and some literal strings. Use targeted `rm` of named files, and restore files with `git show HEAD:<path>`.
- Orca runs `orca.yaml` in each new worktree: it links `.env`, `provider/.env.local` and `provider/medplum.config.json` from the main checkout and installs dependencies. A worktree made with plain `git worktree add` gets neither.
- Docs stay short and in plain English, without restating what the code makes obvious.
