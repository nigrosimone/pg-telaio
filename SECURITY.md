# Security policy

## Reporting a vulnerability

Report it privately, through
[GitHub's advisory form](https://github.com/nigrosimone/pg-telaio/security/advisories/new), or by
email to nigro.simone@gmail.com. Do not open a public issue for something exploitable.

Tell me what the bug lets an attacker do, and give me something I can run: the smallest query
that shows it is worth more than a description.

This is a project maintained by one person, so here is what to expect rather than a promise
nobody could keep: I read reports within a few days, I say whether I can reproduce it, and I
tell you what I am going to do about it. A fix goes out as a patch release, with an advisory
once it is published. If I cannot fix it, I will say that too, and why.

## What is in scope

- any way an interpolated value can end up in the SQL text instead of becoming a parameter
- identifier quoting that a crafted name can break out of
- replies on a pipelined connection delivered to the wrong caller
- a prepared-statement name collision that makes a query run with another query's plan or
  parameters

## What is not in scope

- **node-postgres and PostgreSQL themselves.** The tag sits on pg's public API, so a bug in how
  pg or the server handles what it is given belongs there. Send it to me anyway if you are not
  sure which side it is on, and I will help work it out.
- **Untrusted input passed as an identifier.** The README documents that as the caller's
  responsibility: an identifier is quoted so it cannot break out of its position, but it still
  chooses which table or column the query touches.
- Anything that needs the attacker to already run code in your process.

## Supported versions

The version on npm is the one that gets fixes.
