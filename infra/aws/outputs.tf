output "vllm_public_ip" {
  description = "Public IP address for the optional vLLM host."
  value       = try(aws_instance.vllm.public_ip, null)
}

output "vllm_private_ip" {
  description = "Private IP address for same-VPC app traffic."
  value       = try(aws_instance.vllm.private_ip, null)
}
