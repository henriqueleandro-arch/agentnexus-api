// middleware.js — Tenant isolation and RBAC

/**
 * Extract tenant ID from the X-Tenant-ID header.
 * Every API request must include this header.
 * This simulates the RBAC isolation: the backend only queries the tenant's schema.
 */
function tenantMiddleware(req, res, next) {
  const tenantId = req.headers["x-tenant-id"];
  if (!tenantId) {
    return res.status(400).json({
      error: "Missing X-Tenant-ID header",
      hint: "Include X-Tenant-ID: tenant_acme (or another valid tenant)",
    });
  }

  // Validate tenant ID format to prevent SQL injection
  if (!/^tenant_[a-z0-9_]+$/.test(tenantId)) {
    return res.status(400).json({
      error: "Invalid tenant ID format",
      hint: "Tenant ID must match: tenant_<name> (lowercase alphanumeric)",
    });
  }

  req.tenantId = tenantId;
  next();
}

module.exports = { tenantMiddleware };
