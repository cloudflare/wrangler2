---
"wrangler": patch
---

fix: Always publish to targets

Since wrangler is essentially stateless, it should upload "the state of
the world" on every publish

This wasn't the case for publish targets, i.e. custom domains, routes,
and schedules. For each type of target, wrangler would only publish the
target if their collection in the config was non-empty.

However, this could crop up with unexpected bugs. If you add a
collection of schedules, publish, your worker would be attached to those
schedule triggers. But if you removed them from your config and
republished, that collection would not be updated, and your worker would
still be attached to those schedule triggers.

Or a more likely issue: you add a set of routes, publish, and then
change them to be custom domains, and remove the routes, and republish.
Your worker would be accessible from the custom domains, but _also_ from
the routes you removed.

To fix, we just needed to remove the checks for when to publish to a
target - without any sort of state of "current" publish targets, we
always need to publish the targets in the config.

Most of the diff is just for the tests for publish, which now need to
mock the publishes for these targets on every test
