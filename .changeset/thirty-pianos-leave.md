---
"wrangler": patch
---

refactor: touch up publishing to custom domains

Couple things cleaned up here:

Originally the usage of the /domains api (for publishing to custom domains) was a bit clumsy: we would attempt to optimistically publish, but the api would eagerly fail with specific error codes on why it occurred. This made for some weird control flow for retries with override flags, as well as fragile extraction of error messages.

Now we use the new /domains/changeset api to generate a changeset of actions required to get to a new state of custom domains, which informs us up front of which domains would need to be updated and overridden, and we can pass flags as needed. I do make an extra hop back to the api to lookup what the custom domains requiring updates are already attached to, but given how helpful I imagine that to be, I'm for it.

I also updated the api used for publishing the domains, from /domains to /domains/records. The latter was added to allow us to add flexibility for things like the /domains/changeset resource, and thus the former is being deprecated
