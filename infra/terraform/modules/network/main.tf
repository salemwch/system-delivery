terraform {
  required_version = ">= 1.9.0"

  required_providers {
    digitalocean = {
      source = "digitalocean/digitalocean"
      # Pinned to a minor range, not floating. A provider upgrade can change
      # resource defaults, and infrastructure that changes because someone ran
      # `init` on a different day is not reproducible.
      version = "~> 2.43"
    }
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# VPC — the private network everything talks over.
#
# The managed databases are reachable ONLY from inside it. A managed PostgreSQL
# with a public endpoint is one leaked password away from a full tenant dump,
# and RLS does not help an attacker who has the `dp_migrator` credentials.
# ─────────────────────────────────────────────────────────────────────────────
resource "digitalocean_vpc" "main" {
  name   = "${var.project}-${var.environment}"
  region = var.region

  # A /20 leaves room for the V2 Kubernetes migration without renumbering.
  ip_range = var.vpc_cidr
}

# ─────────────────────────────────────────────────────────────────────────────
# Load balancer — the only thing with a public IP.
#
# TLS terminates here; Cloudflare sits in front for CDN, WAF and DDoS
# (docs/09 §4.1).
# ─────────────────────────────────────────────────────────────────────────────
resource "digitalocean_loadbalancer" "public" {
  name   = "${var.project}-${var.environment}-lb"
  region = var.region

  vpc_uuid = digitalocean_vpc.main.id

  # Redirect rather than serve on 80: the public tracking page is opened from an
  # SMS on a phone, and a plaintext hop leaks the tracking token in the URL.
  redirect_http_to_https = true

  forwarding_rule {
    entry_protocol  = "https"
    entry_port      = 443
    target_protocol = "http"
    target_port     = 80

    certificate_name = var.certificate_name
  }

  # Readiness, not liveness: a droplet that is up but cannot reach PostgreSQL
  # must be taken out of rotation, not left to return 500s.
  healthcheck {
    protocol                 = "http"
    port                     = 80
    path                     = "/ready"
    check_interval_seconds   = 10
    response_timeout_seconds = 5
    unhealthy_threshold      = 3
    healthy_threshold        = 2
  }

  # The WebSocket realtime feed (`wss /v1/realtime`) needs the same client to
  # keep hitting the same instance for the life of the connection.
  sticky_sessions {
    type               = "cookies"
    cookie_name        = "dp_lb"
    cookie_ttl_seconds = 3600
  }

  droplet_tag = var.app_droplet_tag
}

# ─────────────────────────────────────────────────────────────────────────────
# Firewall — default deny.
#
# ⚠️ The application droplets accept HTTP from the LOAD BALANCER ONLY. Without
# the source restriction the droplets are publicly reachable on port 80 and the
# load balancer becomes decorative: an attacker addresses a droplet directly and
# bypasses TLS termination, rate limiting and the WAF in one step.
# ─────────────────────────────────────────────────────────────────────────────
resource "digitalocean_firewall" "app" {
  name = "${var.project}-${var.environment}-app"
  tags = [var.app_droplet_tag]

  inbound_rule {
    protocol                  = "tcp"
    port_range                = "80"
    source_load_balancer_uids = [digitalocean_loadbalancer.public.id]
  }

  # SSH from the bastion range only. An empty list means no SSH at all, which is
  # the correct production posture once deploys run from CI.
  dynamic "inbound_rule" {
    for_each = length(var.ssh_source_addresses) > 0 ? [1] : []
    content {
      protocol         = "tcp"
      port_range       = "22"
      source_addresses = var.ssh_source_addresses
    }
  }

  # Droplets talk to each other over the VPC — the realtime fan-out and the
  # worker's Valkey traffic both cross it.
  inbound_rule {
    protocol         = "tcp"
    port_range       = "1-65535"
    source_addresses = [var.vpc_cidr]
  }

  # Egress is open: the platform calls an SMS aggregator, FCM, and OSRM. Pinning
  # those to address ranges would break the first time a vendor re-IPs, and the
  # egress surface is not where this platform's risk is.
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "53"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}
