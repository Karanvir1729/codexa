output "vllm_base_url" {
  description = "OpenAI-compatible base URL for LOCAL_LLM_BASE_URL."
  value       = "http://${aws_instance.vllm.public_ip}:5000/v1"
}

output "instance_id" {
  value = aws_instance.vllm.id
}

