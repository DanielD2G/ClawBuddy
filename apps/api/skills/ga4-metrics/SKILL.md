---
name: ga4-metrics
description: Collect Google Analytics 4 metrics from any GA4 property. Supports
  summary KPIs, daily time series, dimension breakdowns, period-over-period
  comparison, real-time data, and custom queries.
compatibility: opencode
clawbuddy:
  displayName: Google Analytics 4 Metrics
  version: 1.1.0
  icon: BarChart
  category: integrations
  type: python
  networkAccess: true
  installation: pip install google-analytics-data google-analytics-admin
  tools:
    - name: ga4_summary
      description: 'Get aggregated KPIs for a period: activeUsers, newUsers, sessions,
        screenPageViews, averageSessionDuration, bounceRate.'
      parameters:
        type: object
        properties:
          days:
            type: number
            description: 'Lookback period in days (default: 30). Ignored if
              start_date/end_date are provided.'
          start_date:
            type: string
            description: Start date in YYYY-MM-DD format. Use with end_date for custom
              ranges.
          end_date:
            type: string
            description: 'End date in YYYY-MM-DD format (default: today).'
          timeout:
            type: number
            description: 'Timeout in seconds (default: 30, max: 300)'
        required: []
    - name: ga4_comparison
      description: 'Compare current period vs previous period of equal length. Returns
        both sets of KPIs plus delta percentages for: activeUsers, newUsers,
        sessions, screenPageViews, averageSessionDuration, bounceRate.'
      parameters:
        type: object
        properties:
          days:
            type: number
            description: 'Period length in days (default: 30). Current = last N days,
              previous = N days before that.'
          timeout:
            type: number
            description: 'Timeout in seconds (default: 30, max: 300)'
        required: []
    - name: ga4_daily
      description: Get daily time series of activeUsers, sessions, and
        screenPageViews. Useful for trend charts and spotting anomalies.
      parameters:
        type: object
        properties:
          days:
            type: number
            description: 'Number of days (default: 30)'
          start_date:
            type: string
            description: Start date YYYY-MM-DD. Use with end_date for custom ranges.
          end_date:
            type: string
            description: 'End date YYYY-MM-DD (default: today).'
          timeout:
            type: number
            description: 'Timeout in seconds (default: 30, max: 300)'
        required: []
    - name: ga4_breakdown
      description: 'Break down metrics by a single dimension. Supports any GA4
        dimension: country, browser, deviceCategory, sessionSource, pagePath,
        operatingSystem, sessionMedium, sessionCampaignName,
        landingPagePlusQueryString, etc.'
      parameters:
        type: object
        properties:
          dimension:
            type: string
            description: GA4 dimension name (e.g. 'country', 'browser', 'deviceCategory',
              'sessionSource', 'pagePath', 'operatingSystem')
          metrics:
            type: string
            description: "Comma-separated GA4 metric names (default:
              'activeUsers,sessions'). Examples: screenPageViews,
              averageSessionDuration, bounceRate, newUsers."
          days:
            type: number
            description: 'Lookback period in days (default: 30)'
          limit:
            type: number
            description: 'Max rows to return (default: 10)'
          timeout:
            type: number
            description: 'Timeout in seconds (default: 30, max: 300)'
        required:
          - dimension
    - name: ga4_realtime
      description: Get real-time active users with breakdowns by country, page,
        device, and browser. Data reflects the last 30 minutes.
      parameters:
        type: object
        properties:
          timeout:
            type: number
            description: 'Timeout in seconds (default: 30, max: 300)'
        required: []
  inputs:
    google_credentials_json:
      type: secret
      description: Google Cloud service account credentials JSON (full file content).
        Must have Viewer role on the GA4 property.
    ga4_property_id:
      type: var
      description: GA4 Property ID (numeric only, not the G- Measurement ID). Found in
        GA4 Admin > Property Settings.
      placeholder: '123456789'
---

You collect Google Analytics 4 metrics from any property via the GA4 Data API.

## Credentials setup

Write the service account JSON to a temp file and point `GOOGLE_APPLICATION_CREDENTIALS` at it:

```python
import os, json, tempfile
creds = json.loads(os.environ['GOOGLE_CREDENTIALS_JSON'])
with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
    json.dump(creds, f)
os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = f.name
PROPERTY = f"properties/{os.environ['GA4_PROPERTY_ID']}"
```

## Client and types

```python
from google.analytics.data_v1beta import BetaAnalyticsDataClient
from google.analytics.data_v1beta.types import (
    RunReportRequest, RunRealtimeReportRequest,
    DateRange, Dimension, Metric, OrderBy
)
client = BetaAnalyticsDataClient()
```

## Date ranges

- If `start_date`/`end_date` provided: use them directly in `DateRange`.
- If only `days` provided: `DateRange(start_date=f'{days}daysAgo', end_date='today')`.
- Default: 30 days.

## Tool implementations

**ga4_summary**: Single `RunReportRequest` with 6 metrics, no dimensions.

**ga4_comparison**: Same request but with two `DateRange` entries — GA4 returns one row per range. Calculate deltas as `(current - previous) / previous * 100`.

**ga4_daily**: Add `Dimension(name='date')` and `OrderBy(dimension=...)` on date. Parse date values from `YYYYMMDD` format.

**ga4_breakdown**: Generic — use the `dimension` param as `Dimension(name=dimension)`, split `metrics` on comma, order by first metric desc. Replace `(not set)` with `(direct)` when dimension is `sessionSource`.

**ga4_realtime**: Use `RunRealtimeReportRequest`. Run 5 queries: total (no dimensions), then by country, unifiedScreenName, deviceCategory, browser.

## Response parsing

GA4 returns `row.dimension_values[i].value` (string) and `row.metric_values[i].value` (string — parse to int or float). Values containing `.` are floats, otherwise ints.

## Output

Return clean markdown tables. Always calculate derived metrics when data allows:

- Pages/session = pageViews / sessions
- Device share = device users / total users \* 100
- Duration in both seconds and minutes (if > 60s)
- Bounce rate as percentage (GA4 returns 0-1 range)

## Errors

| Error                                      | Cause                                 | Fix                                                                    |
| ------------------------------------------ | ------------------------------------- | ---------------------------------------------------------------------- |
| `GOOGLE_APPLICATION_CREDENTIALS not found` | Missing or malformed credentials JSON | Verify the full JSON content was provided                              |
| `Property not found`                       | Wrong property ID                     | Must be numeric (e.g. `524872149`), not the Measurement ID (`G-XXXXX`) |
| `Permission denied`                        | Service account lacks access          | Grant Viewer role on the GA4 property                                  |
| `No data`                                  | No traffic in period                  | Try a longer lookback or verify tracking is installed                  |
| `ModuleNotFoundError`                      | pip install failed                    | Run `pip install google-analytics-data`                                |
