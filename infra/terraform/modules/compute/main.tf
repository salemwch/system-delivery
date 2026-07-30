terraform {
  required_version = ">= 1.9.0"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.43"
    }
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Application droplets.
#
# TWO of them, and the count is not arbitrary: it is what makes a rolling deploy
# possible and what stops a single reboot being an outage. It is also the
# configuration under which the realtime WebSocket fan-out is actually exercised
# — with one instance, a dispatcher and a driver always share a process and the
# Valkey pub/sub path never runs. That bug only appears on the second instance.
# ─────────────────────────────────────────────────────────────────────────────
resource "digitalocean_droplet" "app" {
  count = var.app_droplet_count

  name   = "${var.project}-${var.environment}-app-${count.index + 1}"
  region = var.region
  size   = var.app_droplet_size

  # Pinned by slug rather than "latest": an image that changes between applies
  # is infrastructure that cannot be reproduced.
  image = var.droplet_image

  vpc_uuid = var.vpc_id
  ssh_keys = var.ssh_key_fingerprints

  # The tag the load balancer targets and both database firewalls allow.
  tags = [var.app_droplet_tag, var.environment]

  # Metrics for the alerting in docs/09 §8.
  monitoring = true

  # Snapshot-based recovery is the wrong tool for stateless application
  # droplets: they are rebuilt from an image and a compose file, and a backup
  # would only preserve drift that should not exist.
  backups = false

  user_data = var.cloud_init
}

# ─────────────────────────────────────────────────────────────────────────────
# Compute droplet — OSRM only.
#
# Isolated from the API path because OSRM's memory footprint is large and its
# graph load is bursty; a route optimisation must never make a dispatcher's
# board slow. docs/09 §4.1 also placed the solver and ML service here, but
# ADR-005 defers both, so at MVP this box runs one thing.
# ─────────────────────────────────────────────────────────────────────────────
resource "digitalocean_droplet" "compute" {
  count = var.compute_droplet_count

  name   = "${var.project}-${var.environment}-compute-${count.index + 1}"
  region = var.region
  size   = var.compute_droplet_size
  image  = var.droplet_image

  vpc_uuid = var.vpc_id
  ssh_keys = var.ssh_key_fingerprints

  tags       = [var.compute_droplet_tag, var.environment]
  monitoring = true
  backups    = false

  user_data = var.cloud_init
}

# ─────────────────────────────────────────────────────────────────────────────
# The compute droplet is reachable from the app droplets only.
#
# OSRM has no authentication of its own. Anything that can reach the port can
# ask it to route, which at worst is a free routing service on your bill and at
# best is an unauthenticated dependency in the middle of the network.
# ─────────────────────────────────────────────────────────────────────────────
resource "digitalocean_firewall" "compute" {
  count = var.compute_droplet_count > 0 ? 1 : 0

  name = "${var.project}-${var.environment}-compute"
  tags = [var.compute_droplet_tag]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "5000"
    source_addresses = [var.vpc_cidr]
  }

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
}
