# Health Endpoint Integration Guide

**From**: IT Infrastructure Team
**To**: All Development Teams
**Subject**: Adding Health Monitoring to Your Applications

---

## What Is This?

We have deployed **AI Monitor**, a centralized monitoring system that tracks the health of all our web applications in real time. It gives us a live dashboard, uptime history, and automatic alerts when any of our sites go down or become degraded.

**For this to work, your application needs to expose a single HTTP endpoint** — `GET /health` — that returns a small JSON payload describing whether your app is running properly. AI Monitor will call this endpoint every 30 seconds and record the result.

This document tells you everything you need to do. There is nothing else to read or ask about — all the information is here.

---

## What You Need To Do

1. **Add a `/health` endpoint** to your application (details and full code examples below)
2. **Deploy it** with your next release
3. **Tell us the URL** — either email it or use the bulk registration template at the bottom of this document

That's it. We handle the rest (monitoring, alerting, dashboards).

---

## The Health Endpoint Specification

### The Basics

| Property | Value |
|---|---|
| **HTTP Method** | `GET` |
| **Path** | `/health` (we can configure a different path if you need it, e.g., `/healthz` or `/api/health`) |
| **Response Code** | Always return `200 OK` — even if your app is unhealthy |
| **Response Body** | JSON (see below) |
| **Response Time** | Must respond within 10 seconds |

### Why Always Return 200?

We use the JSON body's `status` field to determine health, not the HTTP status code. If your endpoint returns a 500 or is unreachable, AI Monitor marks the app as **offline** (worst state). Use `status: "unhealthy"` in the JSON to tell us something is wrong without triggering an "offline" classification.

---

## Response Format

### Minimum Required Response

This is the absolute minimum your `/health` endpoint must return:

```json
{
  "status": "healthy",
  "timestamp": "2026-04-12T18:30:00.000Z",
  "app": {
    "name": "your-app-name"
  }
}
```

**Three fields. That's it.**

| Field | Type | Description |
|---|---|---|
| `status` | String | **Must be one of**: `"healthy"`, `"degraded"`, or `"unhealthy"` |
| `timestamp` | String (ISO 8601) | The current time in UTC when the response was generated |
| `app.name` | String | A consistent name for your application (e.g., `"user-service"`, `"admin-portal"`) |

### Recommended Full Response

If you want richer monitoring data on the dashboard (and you should — it helps us diagnose issues faster), include subsystem checks:

```json
{
  "status": "healthy",
  "timestamp": "2026-04-12T18:30:00.000Z",
  "app": {
    "name": "user-service",
    "version": "2.1.0",
    "environment": "production"
  },
  "uptime": 86400,
  "checks": {
    "database": {
      "status": "healthy",
      "responseTime": 12,
      "message": "Connected to PostgreSQL"
    },
    "redis": {
      "status": "healthy",
      "responseTime": 2,
      "message": "Cache operational"
    },
    "memory": {
      "status": "healthy",
      "totalMB": 8192,
      "usedMB": 3200,
      "freePercent": 61
    },
    "cpu": {
      "status": "healthy",
      "usagePercent": 32,
      "cores": 4
    },
    "diskSpace": {
      "status": "healthy",
      "usagePercent": 45,
      "freeGB": 55
    },
    "errorRate": {
      "status": "healthy",
      "last5min": 0.2,
      "threshold": 5.0
    }
  },
  "metrics": {
    "requestsPerMinute": 340,
    "avgResponseTimeMs": 120,
    "activeConnections": 45
  }
}
```

### Complete Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `status` | String | **Yes** | Overall health: `"healthy"`, `"degraded"`, or `"unhealthy"` |
| `timestamp` | String | **Yes** | ISO 8601 UTC timestamp of when this response was generated |
| `app.name` | String | **Yes** | Your application's name (keep it consistent across deployments) |
| `app.version` | String | No | Current deployed version (git hash, semver, build number — whatever you use) |
| `app.environment` | String | No | `"production"`, `"staging"`, `"development"`, etc. |
| `uptime` | Number | No | Seconds since the application process started |
| `checks` | Object | No | Individual subsystem checks — each key is a check name |
| `checks.<name>.status` | String | No | `"healthy"`, `"degraded"`, or `"unhealthy"` |
| `checks.<name>.responseTime` | Number | No | Milliseconds the check took |
| `checks.<name>.message` | String | No | Human-readable detail |
| `metrics` | Object | No | Any performance counters you want to expose (we display them in the dashboard) |

You can add **any keys you want** under `checks` and `metrics`. We store the entire payload and display it in the dashboard detail view. Custom data like queue depths, license expiry dates, or third-party API latency are all useful.

---

## Status Logic: When To Report What

| Status | When To Use It | Example |
|---|---|---|
| `"healthy"` | Everything is working normally | All checks pass, response times normal |
| `"degraded"` | Something is impaired but the app still works | Database slow (> 200ms), memory above 80%, high CPU, elevated error rate — but still serving traffic |
| `"unhealthy"` | A critical failure — the app cannot function correctly | Database unreachable, error rate above threshold, critical dependency down |

**Rule of thumb**: Set the overall `status` to the **worst** individual check status.

If your database check returns `"unhealthy"` and everything else is `"healthy"`, the overall status should be `"unhealthy"`.

If your memory check returns `"degraded"` and nothing is unhealthy, the overall status should be `"degraded"`.

### Recommended Thresholds

| Check | Healthy | Degraded | Unhealthy |
|---|---|---|---|
| Database response time | < 200ms | 200ms – 2s | > 2s or unreachable |
| Memory usage | < 80% | 80% – 95% | > 95% |
| CPU usage | < 70% | 70% – 90% | > 90% sustained |
| Disk usage | < 75% | 75% – 90% | > 90% |
| Error rate (per min) | < 1% | 1% – 5% | > 5% |

These are guidelines, not rules. Adjust to what makes sense for your app.

---

## Code Examples

Copy-paste the example for your stack. Each example is a complete, working health endpoint.

---

### Node.js / Express

Save this as `health.js` in your project, then `app.use(require('./health')(...))`.

```javascript
// health.js
const os = require('os');
const startTime = Date.now();

module.exports = function healthEndpoint(options = {}) {
  const { name, version = '1.0.0', checks = {} } = options;
  const env = process.env.NODE_ENV || 'production';

  return async (req, res, next) => {
    if (req.path !== '/health' || req.method !== 'GET') return next();

    // Optional auth (set MONITOR_KEY env var to enable)
    const monitorKey = process.env.MONITOR_KEY;
    if (monitorKey && req.headers['x-monitor-key'] !== monitorKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const checkResults = {};
    let overallStatus = 'healthy';

    // Run all subsystem checks in parallel
    await Promise.allSettled(
      Object.entries(checks).map(async ([checkName, checkFn]) => {
        try {
          const result = await checkFn();
          checkResults[checkName] = result;
          if (result.status === 'unhealthy') overallStatus = 'unhealthy';
          else if (result.status === 'degraded' && overallStatus !== 'unhealthy') overallStatus = 'degraded';
        } catch (err) {
          checkResults[checkName] = { status: 'unhealthy', message: err.message };
          overallStatus = 'unhealthy';
        }
      })
    );

    // Automatic memory check
    const totalMem = Math.round(os.totalmem() / 1048576);
    const freeMem = Math.round(os.freemem() / 1048576);
    const memPct = ((totalMem - freeMem) / totalMem) * 100;
    checkResults.memory = {
      status: memPct > 95 ? 'unhealthy' : memPct > 80 ? 'degraded' : 'healthy',
      totalMB: totalMem,
      usedMB: totalMem - freeMem,
      freePercent: Math.round(100 - memPct),
    };

    res.json({
      status: overallStatus,
      timestamp: new Date().toISOString(),
      app: { name, version, environment: env },
      uptime: Math.floor((Date.now() - startTime) / 1000),
      checks: checkResults,
    });
  };
};
```

**How to use it:**

```javascript
const express = require('express');
const app = express();
const db = require('./your-db'); // your database connection module

app.use(require('./health')({
  name: 'user-service',           // <-- change this to your app name
  version: '2.1.0',
  checks: {
    database: async () => {
      const start = Date.now();
      await db.query('SELECT 1');  // <-- replace with your DB's ping
      return {
        status: 'healthy',
        responseTime: Date.now() - start,
        message: 'Connected to PostgreSQL',
      };
    },
    // Add more checks as needed:
    // redis: async () => { ... },
    // externalApi: async () => { ... },
  },
}));

app.listen(3000);
```

---

### Python / Flask

```python
# health.py
import os, time, psutil
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify

health_bp = Blueprint('health', __name__)

APP_NAME = "my-flask-app"        # <-- change this
APP_VERSION = "1.0.0"            # <-- change this
START_TIME = time.time()


def check_database():
    """Replace with your actual database check."""
    try:
        start = time.time()
        # Example: db.session.execute(text("SELECT 1"))
        elapsed_ms = round((time.time() - start) * 1000)
        return {"status": "healthy", "responseTime": elapsed_ms, "message": "Database connected"}
    except Exception as e:
        return {"status": "unhealthy", "message": str(e)}


@health_bp.route('/health', methods=['GET'])
def health():
    # Optional auth
    monitor_key = os.environ.get('MONITOR_KEY')
    if monitor_key and request.headers.get('X-Monitor-Key') != monitor_key:
        return jsonify({"error": "Unauthorized"}), 401

    checks = {"database": check_database()}

    # Memory
    mem = psutil.virtual_memory()
    checks["memory"] = {
        "status": "unhealthy" if mem.percent > 95 else "degraded" if mem.percent > 80 else "healthy",
        "totalMB": round(mem.total / 1048576),
        "usedMB": round(mem.used / 1048576),
        "freePercent": round(100 - mem.percent),
    }

    # CPU
    cpu = psutil.cpu_percent(interval=0.1)
    checks["cpu"] = {
        "status": "degraded" if cpu > 85 else "healthy",
        "usagePercent": cpu,
        "cores": psutil.cpu_count(),
    }

    # Overall status = worst check
    statuses = [c.get("status", "healthy") for c in checks.values()]
    overall = "unhealthy" if "unhealthy" in statuses else "degraded" if "degraded" in statuses else "healthy"

    return jsonify({
        "status": overall,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "app": {"name": APP_NAME, "version": APP_VERSION, "environment": os.environ.get("FLASK_ENV", "production")},
        "uptime": round(time.time() - START_TIME),
        "checks": checks,
    })
```

**How to use it:**

```python
from flask import Flask
from health import health_bp

app = Flask(__name__)
app.register_blueprint(health_bp)
# ... your existing routes
```

**Dependencies**: `pip install psutil` (for memory/CPU checks — optional, you can remove those checks if you don't want to install psutil).

---

### Python / FastAPI

```python
import os, time, psutil
from datetime import datetime, timezone
from fastapi import FastAPI, Request, HTTPException

app = FastAPI()
APP_NAME = "my-fastapi-app"      # <-- change this
START_TIME = time.time()

@app.get("/health")
async def health(request: Request):
    monitor_key = os.environ.get("MONITOR_KEY")
    if monitor_key and request.headers.get("x-monitor-key") != monitor_key:
        raise HTTPException(status_code=401, detail="Unauthorized")

    checks = {}

    # Add your database check here:
    # checks["database"] = await check_database()

    mem = psutil.virtual_memory()
    checks["memory"] = {
        "status": "unhealthy" if mem.percent > 95 else "degraded" if mem.percent > 80 else "healthy",
        "totalMB": round(mem.total / 1048576),
        "usedMB": round(mem.used / 1048576),
        "freePercent": round(100 - mem.percent),
    }

    statuses = [c.get("status", "healthy") for c in checks.values()]
    overall = "unhealthy" if "unhealthy" in statuses else "degraded" if "degraded" in statuses else "healthy"

    return {
        "status": overall,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "app": {"name": APP_NAME, "version": "1.0.0"},
        "uptime": round(time.time() - START_TIME),
        "checks": checks,
    }
```

---

### C# / ASP.NET Core

Add this controller to your project. No additional packages required.

```csharp
using Microsoft.AspNetCore.Mvc;
using System.Diagnostics;

[ApiController]
public class HealthController : ControllerBase
{
    private static readonly DateTime StartTime = DateTime.UtcNow;

    [HttpGet("/health")]
    public async Task<IActionResult> Health()
    {
        // Optional auth
        var monitorKey = Environment.GetEnvironmentVariable("MONITOR_KEY");
        if (!string.IsNullOrEmpty(monitorKey))
        {
            var provided = Request.Headers["X-Monitor-Key"].FirstOrDefault();
            if (provided != monitorKey)
                return Unauthorized(new { error = "Unauthorized" });
        }

        var checks = new Dictionary<string, object>();
        var overallStatus = "healthy";

        // Database check — uncomment and replace with your DbContext
        // try
        // {
        //     var sw = Stopwatch.StartNew();
        //     await _dbContext.Database.ExecuteSqlRawAsync("SELECT 1");
        //     sw.Stop();
        //     checks["database"] = new { status = "healthy", responseTime = sw.ElapsedMilliseconds, message = "SQL Server connected" };
        // }
        // catch (Exception ex)
        // {
        //     checks["database"] = new { status = "unhealthy", message = ex.Message };
        //     overallStatus = "unhealthy";
        // }

        // Memory
        var process = Process.GetCurrentProcess();
        var memMB = process.WorkingSet64 / 1048576;
        checks["memory"] = new { status = memMB > 1500 ? "degraded" : "healthy", usedMB = memMB };

        return Ok(new
        {
            status = overallStatus,
            timestamp = DateTime.UtcNow.ToString("o"),
            app = new { name = "my-dotnet-app", version = "1.0.0", environment = "production" },
            uptime = (int)(DateTime.UtcNow - StartTime).TotalSeconds,
            checks
        });
    }
}
```

---

### Java / Spring Boot

```java
import org.springframework.web.bind.annotation.*;
import java.time.Instant;
import java.util.*;

@RestController
public class HealthController {

    private static final Instant START_TIME = Instant.now();

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> checks = new LinkedHashMap<>();
        String overallStatus = "healthy";

        // Database check — replace with your JDBC template
        // try {
        //     long start = System.currentTimeMillis();
        //     jdbcTemplate.execute("SELECT 1");
        //     checks.put("database", Map.of("status", "healthy", "responseTime", System.currentTimeMillis() - start));
        // } catch (Exception e) {
        //     checks.put("database", Map.of("status", "unhealthy", "message", e.getMessage()));
        //     overallStatus = "unhealthy";
        // }

        // Memory
        Runtime rt = Runtime.getRuntime();
        long usedMB = (rt.totalMemory() - rt.freeMemory()) / 1048576;
        long totalMB = rt.maxMemory() / 1048576;
        checks.put("memory", Map.of(
            "status", usedMB > totalMB * 0.9 ? "degraded" : "healthy",
            "usedMB", usedMB, "totalMB", totalMB
        ));

        return Map.of(
            "status", overallStatus,
            "timestamp", Instant.now().toString(),
            "app", Map.of("name", "my-spring-app", "version", "1.0.0"),
            "uptime", Instant.now().getEpochSecond() - START_TIME.getEpochSecond(),
            "checks", checks
        );
    }
}
```

---

### Static Sites (No Server-Side Code)

If your app has no backend (e.g., a static site on Azure Static Web Apps), create a file called `health.json` in your public directory:

```json
{
  "status": "healthy",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "app": { "name": "my-static-site" }
}
```

Tell us the health path is `/health.json` instead of `/health`. The timestamp won't update, but we'll still know when the site goes down (unreachable).

For Azure Static Web Apps specifically, you can use an Azure Function as a health endpoint — ask us if you need help setting that up.

---

## Authentication (Optional)

If your health endpoint is publicly accessible and you want to restrict it to only our monitor:

1. Set a `MONITOR_KEY` environment variable on your app (any random string)
2. Tell us the key when you register the site (we enter it in the "Auth Key" field)
3. In your health endpoint code, validate the `X-Monitor-Key` header matches your key

All the code examples above include the authentication logic — just set the `MONITOR_KEY` env var to activate it.

If your health endpoint is behind a VPN or on an internal network, authentication is optional.

---

## Testing Your Endpoint

Before you tell us about your app, test it locally:

```bash
# 1. Does it return 200?
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health
# Expected: 200

# 2. Is the JSON valid and correct?
curl -s http://localhost:3000/health | python -m json.tool
# or: curl -s http://localhost:3000/health | jq .

# 3. Does it respond fast enough?
curl -s -o /dev/null -w "Time: %{time_total}s\n" http://localhost:3000/health
# Should be well under 10 seconds

# 4. With auth (if you're using it):
curl -s -H "X-Monitor-Key: your-key" http://localhost:3000/health | jq .
```

### Checklist Before Going Live

- [ ] `GET /health` returns HTTP `200`
- [ ] Response is valid JSON
- [ ] `status` field present (`"healthy"`, `"degraded"`, or `"unhealthy"`)
- [ ] `timestamp` field present (ISO 8601 format)
- [ ] `app.name` field present
- [ ] Responds in under 10 seconds
- [ ] Works without authentication cookies/sessions (plain GET request)
- [ ] Works when the app is under load

---

## Registering Your App With Us

### Option A: Send Us the Details

Email or message us with:

- **App name**: e.g., "User Service"
- **URL**: e.g., `https://user-svc.azurewebsites.net`
- **Health path**: `/health` (or custom path if you used one)
- **Group**: e.g., "Production", "Staging", "Internal"
- **Auth key**: (if you set one up)

### Option B: Fill Out This Template

Copy this CSV, fill in your apps, and send it to us. We can import them all at once.

```csv
name,url,health_path,group_name,monitor_key
My App Name,https://myapp.azurewebsites.net,/health,Production,
Another App,https://another.azurewebsites.net,/health,Production,
Internal Tool,https://tool.internal.com,/healthz,Internal,my-secret-key
```

Or as JSON if you prefer:

```json
[
  {
    "name": "My App Name",
    "url": "https://myapp.azurewebsites.net",
    "health_path": "/health",
    "group_name": "Production"
  },
  {
    "name": "Another App",
    "url": "https://another.azurewebsites.net",
    "health_path": "/health",
    "group_name": "Production"
  }
]
```

---

## Common Questions

**Do I have to use `/health` as the path?**
No. Use whatever works for your app. Just tell us the path when you register. `/health`, `/healthz`, `/api/health`, `/status` — all fine.

**What if I have multiple instances behind a load balancer?**
Register the load balancer URL. We check the same URL your users hit. We don't need access to individual instances.

**How often will you check my app?**
Every 30 seconds by default.

**Will the health checks slow down my app?**
No. One lightweight GET request every 30 seconds is negligible. But keep your health check fast — don't run expensive queries. Use `SELECT 1`, not `SELECT COUNT(*) FROM big_table`.

**What if I can't modify my app's code right now?**
Send us the URL anyway. We can monitor basic reachability (is the site up or down?) without a proper health endpoint. You'll just get less detailed diagnostics. Add the full health endpoint when you can.

**What triggers an alert?**
We send alerts when your app transitions between states — specifically when it goes from healthy to unhealthy/offline, becomes degraded, or recovers. We don't spam alerts for every check; there's a 15-minute cooldown between repeat alerts for the same site.

**What if my health endpoint accidentally breaks?**
If your `/health` path returns a 500 error or malformed JSON, we'll mark it as unhealthy (not offline). If the path becomes completely unreachable, we'll mark it as offline. Either way, you'll get an alert and can fix it.

**I use a different framework not listed here. What do I do?**
The concept is the same for any language/framework: handle `GET /health`, return JSON with `status`, `timestamp`, and `app.name`. The code examples above should give you enough to translate to any stack. If you're stuck, reach out.

---

## Summary

| What | Details |
|---|---|
| **Your app exposes** | `GET /health` returning JSON |
| **Minimum response** | `{ "status": "healthy", "timestamp": "...", "app": { "name": "..." } }` |
| **Status values** | `"healthy"`, `"degraded"`, `"unhealthy"` |
| **HTTP status** | Always `200 OK` |
| **Timeout** | 10 seconds max |
| **Auth** | Optional — `X-Monitor-Key` header |
| **We check** | Every 30 seconds |
| **We alert on** | State changes (down, degraded, recovered) |
