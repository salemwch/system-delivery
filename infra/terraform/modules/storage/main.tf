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
# Proof-of-delivery media.
#
# Signatures and photos. ⚠️ These are LEGALLY SIGNIFICANT and IRREPLACEABLE: a
# POD photo is what settles a dispute about whether a parcel arrived, and it
# cannot be regenerated from anything. That single fact drives every setting
# below.
# ─────────────────────────────────────────────────────────────────────────────
resource "digitalocean_spaces_bucket" "pod" {
  name   = "${var.project}-${var.environment}-pod"
  region = var.spaces_region

  # ⚠️ PRIVATE. A public bucket of delivery photos is a live feed of customer
  # addresses, faces and signatures. Access is exclusively through short-lived
  # pre-signed URLs the API issues.
  acl = "private"

  # Versioning is what survives a bug that overwrites a POD with the wrong
  # parcel's photo, and a deletion nobody meant. docs/09 §9 requires it.
  versioning {
    enabled = true
  }

  # Retention per docs/06 §9: POD media is hot for 2 years, then archived, and
  # deleted at 7 — the commercial dispute window. Spaces has no storage classes,
  # so the lifecycle expires non-current versions and lets the archive step be a
  # V2 concern when the estate moves to S3.
  lifecycle_rule {
    id      = "pod-retention"
    enabled = true

    expiration {
      # 7 years.
      days = 2555
    }

    noncurrent_version_expiration {
      # A superseded version is only interesting while investigating the
      # overwrite that produced it.
      days = 90
    }

    # A multipart upload abandoned by a driver on a failing connection is
    # invisible in listings and billed forever.
    abort_incomplete_multipart_upload_days = 7
  }

  # Never inherit deletion protection from luck. `force_destroy` stays false so
  # `terraform destroy` cannot silently take seven years of legal evidence with
  # it — emptying the bucket has to be a deliberate, separate act.
  force_destroy = false
}

# ─────────────────────────────────────────────────────────────────────────────
# CORS: the driver app uploads directly to Spaces via a pre-signed URL.
#
# Direct upload rather than proxying through the API, because a POD photo is a
# megabyte from a phone on a Tunisian mobile network — routing that through the
# API ties up a request thread for the duration of a slow upload.
# ─────────────────────────────────────────────────────────────────────────────
resource "digitalocean_spaces_bucket_cors_configuration" "pod" {
  bucket = digitalocean_spaces_bucket.pod.id
  region = digitalocean_spaces_bucket.pod.region

  cors_rule {
    # Explicit origins, never "*": a wildcard lets any page a driver visits
    # replay their pre-signed URL from the browser.
    allowed_origins = var.allowed_origins
    allowed_methods = ["GET", "PUT"]
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}
