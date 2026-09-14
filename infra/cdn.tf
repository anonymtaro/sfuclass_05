/**
 * infra/cdn.tf [EXT] + signed URLs for HLS, + SPA origin
 * Two distributions: "web" serves the Vite build (hashed assets immutable,
 * index.html never cached); "delivery" fronts the media/delivery S3 bucket
 * with a trusted key group so AssetDelivery.js/DownloadService.js can mint
 * short-TTL signed URLs for HLS, chat attachments and recordings.
 */

resource "aws_s3_bucket" "web" {
  bucket = "${local.name_prefix}-web"
  tags   = { Name = "${local.name_prefix}-web" }
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.name_prefix}-web-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "delivery" {
  name                              = "${local.name_prefix}-delivery-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  default_root_object = "index.html"
  aliases             = ["app.${var.domain_name}"]
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "web-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  default_cache_behavior {
    target_origin_id        = "web-s3"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  ordered_cache_behavior {
    path_pattern            = "/index.html"
    target_origin_id        = "web-s3"
    viewer_protocol_policy  = "redirect-to-https"
    allowed_methods         = ["GET", "HEAD"]
    cached_methods          = ["GET", "HEAD"]
    cache_policy_id         = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cloudfront.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = { Name = "${local.name_prefix}-web-cdn" }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.web.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.web.arn }
      }
    }]
  })
}

resource "aws_cloudfront_public_key" "delivery_signing" {
  count       = var.cdn_public_key_pem == null ? 0 : 1
  name        = "${local.name_prefix}-delivery-signing-key"
  encoded_key = var.cdn_public_key_pem
}

resource "aws_cloudfront_key_group" "delivery_signing" {
  count = var.cdn_public_key_pem == null ? 0 : 1
  name  = "${local.name_prefix}-delivery-signing-group"
  items = [aws_cloudfront_public_key.delivery_signing[0].id]
}

resource "aws_cloudfront_distribution" "delivery" {
  enabled     = true
  aliases     = ["cdn.${var.domain_name}", "media.${var.domain_name}"]
  price_class = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.delivery.bucket_regional_domain_name
    origin_id                = "delivery-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.delivery.id
  }

  default_cache_behavior {
    target_origin_id       = "delivery-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods          = ["GET", "HEAD"]
    compress                = true
    cache_policy_id         = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    trusted_key_groups      = var.cdn_public_key_pem == null ? null : [aws_cloudfront_key_group.delivery_signing[0].id]
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cloudfront.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = { Name = "${local.name_prefix}-delivery-cdn" }
}

resource "aws_s3_bucket_policy" "delivery" {
  bucket = aws_s3_bucket.delivery.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.delivery.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.delivery.arn }
      }
    }]
  })
}