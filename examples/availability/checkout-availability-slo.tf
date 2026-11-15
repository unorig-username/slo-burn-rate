# Grafana-managed alert rules (grafana/grafana provider) for the checkout SLO: 99.9% over 30d (availability).
# Multiwindow, multi-burn-rate alerts (Google SRE Workbook, chapter 5).
# Edit: https://slo.coreyjones.dev/
# runbook_url values are placeholders.

variable "prometheus_datasource_uid" {
  type        = string
  description = "UID of the Prometheus datasource the rules query."
}

variable "folder_uid" {
  type        = string
  description = "UID of the Grafana folder that holds the rule group."
}

resource "grafana_rule_group" "slo_checkout_availability" {
  name             = "slo-checkout-availability"
  folder_uid       = var.folder_uid
  interval_seconds = 60

  rule {
    name           = "checkout availability SLO burn 1h/5m"
    condition      = "D"
    for            = "1m"
    no_data_state  = "NoData"
    exec_err_state = "Error"
    labels = {
      severity     = "page"
      slo          = "checkout-availability"
      long_window  = "1h"
      short_window = "5m"
    }
    annotations = {
      summary     = "checkout availability SLO is burning its error budget at 14.4x (2% of the 30d budget in 1h)"
      description = "Error ratio over the last 1h is {{ with $values.A }}{{ humanizePercentage .Value }}{{ else }}unknown (no data){{ end }}. Alert threshold is 1.44% errors (14.4x burn on a 99.9% SLO, 1h and 5m windows). At this rate the 30d budget lasts 2d 2h."
      runbook_url = "https://example.com/REPLACE-ME/runbooks/slo-checkout-availability"
    }

    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "A"
        expr    = "(sum(rate(http_requests_total{job=\"checkout\",code=~\"5..\"}[1h])) or 0 * sum(rate(http_requests_total{job=\"checkout\"}[1h]))) / sum(rate(http_requests_total{job=\"checkout\"}[1h]))"
        instant = true
        range   = false
      })
    }

    data {
      ref_id         = "B"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "B"
        expr    = "(sum(rate(http_requests_total{job=\"checkout\",code=~\"5..\"}[5m])) or 0 * sum(rate(http_requests_total{job=\"checkout\"}[5m]))) / sum(rate(http_requests_total{job=\"checkout\"}[5m]))"
        instant = true
        range   = false
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "C"
        expr    = "sum(rate(http_requests_total{job=\"checkout\"}[1h]))"
        instant = true
        range   = false
      })
    }

    data {
      ref_id         = "D"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId      = "D"
        type       = "math"
        expression = "$A > 0.0144 && $B > 0.0144 && $C > 1"
      })
    }
  }

  rule {
    name           = "checkout availability SLO burn 6h/30m"
    condition      = "D"
    for            = "1m"
    no_data_state  = "NoData"
    exec_err_state = "Error"
    labels = {
      severity     = "page"
      slo          = "checkout-availability"
      long_window  = "6h"
      short_window = "30m"
    }
    annotations = {
      summary     = "checkout availability SLO is burning its error budget at 6x (5% of the 30d budget in 6h)"
      description = "Error ratio over the last 6h is {{ with $values.A }}{{ humanizePercentage .Value }}{{ else }}unknown (no data){{ end }}. Alert threshold is 0.6% errors (6x burn on a 99.9% SLO, 6h and 30m windows). At this rate the 30d budget lasts 5d."
      runbook_url = "https://example.com/REPLACE-ME/runbooks/slo-checkout-availability"
    }

    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "A"
        expr    = "(sum(rate(http_requests_total{job=\"checkout\",code=~\"5..\"}[6h])) or 0 * sum(rate(http_requests_total{job=\"checkout\"}[6h]))) / sum(rate(http_requests_total{job=\"checkout\"}[6h]))"
        instant = true
        range   = false
      })
    }

    data {
      ref_id         = "B"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "B"
        expr    = "(sum(rate(http_requests_total{job=\"checkout\",code=~\"5..\"}[30m])) or 0 * sum(rate(http_requests_total{job=\"checkout\"}[30m]))) / sum(rate(http_requests_total{job=\"checkout\"}[30m]))"
        instant = true
        range   = false
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "C"
        expr    = "sum(rate(http_requests_total{job=\"checkout\"}[6h]))"
        instant = true
        range   = false
      })
    }

    data {
      ref_id         = "D"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId      = "D"
        type       = "math"
        expression = "$A > 0.006 && $B > 0.006 && $C > 1"
      })
    }
  }

  rule {
    name           = "checkout availability SLO burn 1d/2h"
    condition      = "D"
    for            = "1m"
    no_data_state  = "NoData"
    exec_err_state = "Error"
    labels = {
      severity     = "ticket"
      slo          = "checkout-availability"
      long_window  = "1d"
      short_window = "2h"
    }
    annotations = {
      summary     = "checkout availability SLO is burning its error budget at 3x (10% of the 30d budget in 1d)"
      description = "Error ratio over the last 1d is {{ with $values.A }}{{ humanizePercentage .Value }}{{ else }}unknown (no data){{ end }}. Alert threshold is 0.3% errors (3x burn on a 99.9% SLO, 1d and 2h windows). At this rate the 30d budget lasts 10d."
      runbook_url = "https://example.com/REPLACE-ME/runbooks/slo-checkout-availability"
    }

    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "A"
        expr    = "(sum(rate(http_requests_total{job=\"checkout\",code=~\"5..\"}[1d])) or 0 * sum(rate(http_requests_total{job=\"checkout\"}[1d]))) / sum(rate(http_requests_total{job=\"checkout\"}[1d]))"
        instant = true
        range   = false
      })
    }

    data {
      ref_id         = "B"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "B"
        expr    = "(sum(rate(http_requests_total{job=\"checkout\",code=~\"5..\"}[2h])) or 0 * sum(rate(http_requests_total{job=\"checkout\"}[2h]))) / sum(rate(http_requests_total{job=\"checkout\"}[2h]))"
        instant = true
        range   = false
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "C"
        expr    = "sum(rate(http_requests_total{job=\"checkout\"}[1d]))"
        instant = true
        range   = false
      })
    }

    data {
      ref_id         = "D"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId      = "D"
        type       = "math"
        expression = "$A > 0.003 && $B > 0.003 && $C > 1"
      })
    }
  }

  rule {
    name           = "checkout availability SLO burn 3d/6h"
    condition      = "D"
    for            = "1m"
    no_data_state  = "NoData"
    exec_err_state = "Error"
    labels = {
      severity     = "ticket"
      slo          = "checkout-availability"
      long_window  = "3d"
      short_window = "6h"
    }
    annotations = {
      summary     = "checkout availability SLO is burning its error budget at 1x (10% of the 30d budget in 3d)"
      description = "Error ratio over the last 3d is {{ with $values.A }}{{ humanizePercentage .Value }}{{ else }}unknown (no data){{ end }}. Alert threshold is 0.1% errors (1x burn on a 99.9% SLO, 3d and 6h windows). At this rate the 30d budget lasts 30d."
      runbook_url = "https://example.com/REPLACE-ME/runbooks/slo-checkout-availability"
    }

    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "A"
        expr    = "(sum(rate(http_requests_total{job=\"checkout\",code=~\"5..\"}[3d])) or 0 * sum(rate(http_requests_total{job=\"checkout\"}[3d]))) / sum(rate(http_requests_total{job=\"checkout\"}[3d]))"
        instant = true
        range   = false
      })
    }

    data {
      ref_id         = "B"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "B"
        expr    = "(sum(rate(http_requests_total{job=\"checkout\",code=~\"5..\"}[6h])) or 0 * sum(rate(http_requests_total{job=\"checkout\"}[6h]))) / sum(rate(http_requests_total{job=\"checkout\"}[6h]))"
        instant = true
        range   = false
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "C"
        expr    = "sum(rate(http_requests_total{job=\"checkout\"}[3d]))"
        instant = true
        range   = false
      })
    }

    data {
      ref_id         = "D"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId      = "D"
        type       = "math"
        expression = "$A > 0.001 && $B > 0.001 && $C > 1"
      })
    }
  }
}
