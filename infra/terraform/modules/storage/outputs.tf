output "bucket_name" {
  description = "S3_BUCKET."
  value       = digitalocean_spaces_bucket.pod.name
}

output "bucket_endpoint" {
  description = "S3_ENDPOINT. Spaces is S3-compatible, so the existing client works unchanged."
  value       = "https://${digitalocean_spaces_bucket.pod.region}.digitaloceanspaces.com"
}

output "bucket_domain_name" {
  description = "Fully-qualified bucket domain, for pre-signed URL construction."
  value       = digitalocean_spaces_bucket.pod.bucket_domain_name
}
