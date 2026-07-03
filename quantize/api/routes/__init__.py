"""HTTP route modules. Each router owns one endpoint family and opens its own ``Database`` handle
in the handler body (per-request, single-thread — never shared)."""
