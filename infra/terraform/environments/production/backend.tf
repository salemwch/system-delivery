/**
 * Remote state with locking (docs/09 §7).
 *
 * ⚠️ State is NOT in this repository and never will be. It contains every
 * database connection string and every generated password in plaintext —
 * committing it would publish the production credentials to anyone with read
 * access, and rotating out of that is a very bad afternoon.
 *
 * Spaces is S3-compatible, so the `s3` backend works with three overrides for
 * the things it would otherwise infer from AWS.
 *
 * The bucket must exist BEFORE the first `init`. Creating it in Terraform would
 * be a chicken-and-egg problem — the state describing the state bucket has
 * nowhere to live — so it is the one resource made by hand.
 */
terraform {
  backend "s3" {
    bucket = "delivery-tfstate"
    key    = "production/terraform.tfstate"
    region = "fra1"

    endpoints = {
      s3 = "https://fra1.digitaloceanspaces.com"
    }

    # Spaces is not AWS: skip the checks that assume it is.
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true

    # Locking via a DynamoDB-compatible table is unavailable on Spaces. Serialise
    # applies through CI concurrency control instead — one apply at a time per
    # environment, enforced by the workflow rather than the backend.
    use_lockfile = true
  }
}
