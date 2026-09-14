/**
 * infra/push.tf [NEW] SNS platform applications (F5)
 * identity/DeviceRegistry.js registers device tokens against these two
 * platform applications; community/NotificationService.js and
 * messaging/UnreadService.js publish through them.
 */

resource "aws_sns_platform_application" "apns" {
  name                = "${local.name_prefix}-apns"
  platform            = var.environment == "prod" ? "APNS" : "APNS_SANDBOX"
  platform_credential = var.apns_private_key_pem
  platform_principal  = var.apns_certificate_pem

  success_feedback_sample_rate = 100
}

resource "aws_sns_platform_application" "fcm" {
  name                = "${local.name_prefix}-fcm"
  platform            = "GCM" # SNS's legacy name for the FCM HTTP v1 integration
  platform_credential = var.fcm_service_account_json

  success_feedback_sample_rate = 100
}