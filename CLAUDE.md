# Instructions for Claude and other AI agents

This is our fork of Documenso. [AGENTS.md](AGENTS.md) describes the codebase;
this file adds the drschoice rules.

## AWS changes (drschoice/devops#24)

Sessions in every drschoice repo use the same AWS identity (`aziz`, account
`979199114165`), so AWS can't tell them apart. Before changing anything in AWS,
follow [drschoice/devops `CLAUDE.md`](https://github.com/drschoice/devops/blob/master/CLAUDE.md):

- Only the session the user has said owns AWS changes may make them. Every other
  session may read (describe, list, logs, metrics) but changes nothing: it opens
  an issue or PR in drschoice/devops instead.
- Infrastructure changes go through code and a PR (in drschoice/devops, or the
  repo that already holds that stack). Incidents are the exception: fix first,
  then write it up in drschoice/devops the same day.
- Investigations and spikes stay out of code.

This is about changing AWS resources and settings. Shipping this repo's code
through its normal deploy pipeline is not an AWS change.
