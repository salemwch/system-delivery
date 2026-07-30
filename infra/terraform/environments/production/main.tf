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
  # Never in a file. Supplied as TF_VAR_do_token from the CI secret store.
  token = var.do_token

  # Spaces uses S3-compatible credentials, which are separate from the API token.
  spaces_access_id  = var.spaces_access_id
  spaces_secret_key = var.spaces_secret_key
}

locals {
  project     = "delivery"
  environment = "production"

  app_tag     = "${local.project}-${local.environment}-app"
  compute_tag = "${local.project}-${local.environment}-compute"
}

module "network" {
  source = "../../modules/network"

  project          = local.project
  environment      = local.environment
  region           = var.region
  vpc_cidr         = "10.20.0.0/20"
  certificate_name = var.certificate_name
  app_droplet_tag  = local.app_tag

  # ⚠️ EMPTY IN PRODUCTION. Deploys run from CI, so no SSH rule is created at
  # all — which is stronger than a narrow one, and removes the standing question
  # of whose laptop is on the allow-list this month.
  ssh_source_addresses = []
}

module "database" {
  source = "../../modules/database"

  project     = local.project
  environment = local.environment
  region      = var.region
  vpc_id      = module.network.vpc_id

  postgres_size       = "db-s-4vcpu-8gb"
  postgres_node_count = 2
  valkey_size         = "db-s-2vcpu-4gb"
  valkey_node_count   = 2

  # Only these tags may connect. Anything else in the VPC is refused.
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
  app_droplet_size  = "s-4vcpu-8gb"

  compute_droplet_count = 1
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
