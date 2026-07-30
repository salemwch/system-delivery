output "vpc_id" {
  description = "VPC uuid — every other module attaches to it."
  value       = digitalocean_vpc.main.id
}

output "vpc_cidr" {
  description = "The private range, for firewall rules in other modules."
  value       = digitalocean_vpc.main.ip_range
}

output "load_balancer_ip" {
  description = "Public IP. The DNS A record points here."
  value       = digitalocean_loadbalancer.public.ip
}
