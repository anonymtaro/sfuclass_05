/**
 * infra/outputs.tf [EXT]
 * Consumed by: alb.tf / ecs-sfu.tf (subnet & SG ids), .github/workflows/terraform.yml
 * (for plan/apply diagnostics), and the registrar / DNS delegation step for
 * a brand-new environment (zone name servers).
 */

output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "security_group_ids" {
  value = {
    alb         = aws_security_group.alb.id
    ecs_tasks   = aws_security_group.ecs_tasks.id
    sfu         = aws_security_group.sfu.id
    rds         = aws_security_group.rds.id
    redis       = aws_security_group.redis.id
    opensearch  = aws_security_group.opensearch.id
    vpc_endpoints = aws_security_group.vpc_endpoints.id
  }
}

output "acm_certificate_arn_alb" {
  value = aws_acm_certificate_validation.alb.certificate_arn
}

output "acm_certificate_arn_cloudfront" {
  value = aws_acm_certificate_validation.cloudfront.certificate_arn
}

output "route53_zone_id" {
  value = aws_route53_zone.this.zone_id
}

output "route53_name_servers" {
  description = "Delegate the domain registrar to these NS records for a fresh environment."
  value       = aws_route53_zone.this.name_servers
}