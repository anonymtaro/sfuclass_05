/**
 * infra/acm.tf [NEW] TLS certs (us-east-1 for CloudFront)
 * Two certificates because CloudFront is the one AWS service that only ever
 * reads certificates from us-east-1, no matter which region it fronts.
 * Both are DNS-validated against the same Route 53 zone (route53.tf).
 */

# ---- Regional cert: ALB terminates HTTPS/WSS for api./ws./app. ----
resource "aws_acm_certificate" "alb" {
  domain_name = var.domain_name
  subject_alternative_names = [
    "api.${var.domain_name}",
    "ws.${var.domain_name}",
    "app.${var.domain_name}",
  ]
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.name_prefix}-alb-cert" }
}

resource "aws_route53_record" "alb_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.alb.domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }

  zone_id         = aws_route53_zone.this.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "alb" {
  certificate_arn         = aws_acm_certificate.alb.arn
  validation_record_fqdns = [for r in aws_route53_record.alb_cert_validation : r.fqdn]
}

# ---- us-east-1 cert: CloudFront terminates HTTPS for cdn./media. (SPA + delivery) ----
resource "aws_acm_certificate" "cloudfront" {
  provider = aws.us_east_1

  domain_name = "cdn.${var.domain_name}"
  subject_alternative_names = [
    "media.${var.domain_name}",
  ]
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.name_prefix}-cloudfront-cert" }
}

resource "aws_route53_record" "cloudfront_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cloudfront.domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }

  zone_id         = aws_route53_zone.this.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "cloudfront" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cloudfront.arn
  validation_record_fqdns = [for r in aws_route53_record.cloudfront_cert_validation : r.fqdn]
}