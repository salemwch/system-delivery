terraform {
  required_version = ">= 1.9.0"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.43"
    }
  }
}

provider "digitalocean" {
  token             = var.do_token
  spaces_access_id  = var.spaces_access_id
  spaces_secret_key = var.spaces_secret_key
}

locals {
  project     = "delivery"
  environment = "staging"

  app_tag     = "${local.project}-${local.environment}-app"
  compute_tag = "${local.project}-${local.environment}-compute"
}

# ─────────────────────────────────────────────────────────────────────────────
# Staging: the SAME TOPOLOGY as production, smaller (docs/09 §5).
#
# ⚠️ "Same topology" is the requirement, not "similar". Staging keeps two
# application droplets and a two-node database for one reason each:
#
#   * TWO APP DROPLETS — with one, a dispatcher and a driver always share a
#     process and the Valkey pub/sub fan-out behind the realtime feed never
#     runs. That bug appears only on the second instance, so a single-droplet
#     staging would find it in production.
#
#   * TWO DATABASE NODES — failover behaviour, and the connection handling
#     around it, is exactly the thing you do not want to meet for the first time
#     during a real incident.
#
# What legitimately shrinks is SIZE. What must not shrink is SHAPE.
#
# The sandbox tenant (§5) shares this infrastructure and is isolated by RLS,
# which is the same mechanism protecting real tenants — so it exercises the
# isolation rather than bypassing it.
# ─────────────────────────────────────────────────────────────────────────────
module "network" {
  source = "../../modules/network"

  project          = local.project
  environment      = local.environment
  region           = var.region
  vpc_cidr         = "10.21.0.0/20"
  certificate_name = var.certificate_name
  app_droplet_tag  = local.app_tag

  # Staging permits SSH from the office range, because reproducing a production
  # issue here is how it gets diagnosed without touching production.
  ssh_source_addresses = var.ssh_source_addresses
}

module "database" {
  source = "../../modules/database"

  project     = local.project
  environment = local.environment
  region      = var.region
  vpc_id      = module.network.vpc_id

  # Smaller, but still a standby pair.
  postgres_size       = "db-s-1vcpu-2gb"
  postgres_node_count = 2
  valkey_size         = "db-s-1vcpu-2gb"
  valkey_node_count   = 2

  allowed_droplet_tags = [local.app_tag, local.compute_tag]
}

module "compute" {
  source = "../../modules/compute"

  project     = local.project
  environment = local.environment
  region      = var.region
  vpc_id      = module.network.vpc_id
  vpc_cidr    = module.network.vpc_cidr

  app_droplet_count = 2
  app_droplet_size  = "s-2vcpu-4gb"

  # OSRM off by default in staging: the graph needs the same memory here as in
  # production, and routing falls back to Haversine NN+2-opt when unavailable.
  # Raise to 1 when testing the OSRM binding itself.
  compute_droplet_count = 0
  compute_droplet_size  = "s-8vcpu-16gb"

  app_droplet_tag     = local.app_tag
  compute_droplet_tag = local.compute_tag

  ssh_key_fingerprints = var.ssh_key_fingerprints
}

module "storage" {
  source = "../../modules/storage"

  project       = local.project
  environment   = local.environment
  spaces_region = var.region

  allowed_origins = var.allowed_origins
}
