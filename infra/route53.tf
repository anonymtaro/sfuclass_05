/**
 * infra/route53.tf [NEW]
 * One hosted zone: app · api · ws · sfu-* · cdn · media
 * api and ws both alias the same ALB — Socket.IO and REST share one load
 * balancer, split only by path/host rule inside alb.tf. sfu-* is a wildcard
 * because individual SFU nodes register/deregister with the NLB as ECS
 * replaces them; Terraform owns the wildcard, not per-node records.
 */

resource "aws_route53_zone" "this" {
  name    = var.domain_name
  comment = "classroom-platform (${var.environment})"

  tags = { Name = "${local.name_prefix}-zone" }
}

# ---- app.<domain> -> CloudFront (SPA) ----
resource "aws_route53_record" "app" {
  zone_id = aws_route53_zone.this.zone_id
  name    = "app.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}

# ---- api.<domain> -> ALB (REST, bearer-token API) ----
resource "aws_route53_record" "api" {
  zone_id = aws_route53_zone.this.zone_id
  name    = "api.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# ---- ws.<domain> -> same ALB (Socket.IO: chat, presence, community, Yjs) ----
resource "aws_route53_record" "ws" {
  zone_id = aws_route53_zone.this.zone_id
  name    = "ws.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# ---- cdn.<domain> -> CloudFront (delivery: HLS, signed chat/media downloads) ----
resource "aws_route53_record" "cdn" {
  zone_id = aws_route53_zone.this.zone_id
  name    = "cdn.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.delivery.domain_name
    zone_id                = aws_cloudfront_distribution.delivery.hosted_zone_id
    evaluate_target_health = false
  }
}

# ---- media.<domain> -> same CloudFront delivery distribution, second host header ----
resource "aws_route53_record" "media" {
  zone_id = aws_route53_zone.this.zone_id
  name    = "media.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.delivery.domain_name
    zone_id                = aws_cloudfront_distribution.delivery.hosted_zone_id
    evaluate_target_health = false
  }
}

# ---- sfu-*.<domain> -> NLB (mediasoup, UDP media + TURN-over-TCP fallback) ----
resource "aws_route53_record" "sfu_wildcard" {
  zone_id = aws_route53_zone.this.zone_id
  name    = "sfu-*.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_lb.sfu.dns_name
    zone_id                = aws_lb.sfu.zone_id
    evaluate_target_health = true
  }
}