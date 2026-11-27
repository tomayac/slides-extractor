// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Transformers.js imports `Tensor` from `onnxruntime-common`, while the
// ONNX Runtime Web bundle carries its own copy of that package. Both must be
// the same class, so this re-exports the bundle's.
export * from 'onnxruntime-web/webgpu';
