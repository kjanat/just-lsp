use super::*;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Unexport {
  pub(crate) name: TextNode,
  pub(crate) range: lsp::Range,
}
