use super::*;

define_rule! {
  /// Emits an error when a variable is both exported and unexported.
  ExportUnexportConflictRule {
    id: "export-unexport-conflict",
    message: "export/unexport conflict",
    run(context) {
      let mut diagnostics = Vec::new();

      let exported_names: HashSet<String> = context
        .variables()
        .iter()
        .filter(|v| v.export)
        .map(|v| v.name.value.clone())
        .collect();

      for unexport in context.unexports() {
        if exported_names.contains(&unexport.name.value) {
          diagnostics.push(Diagnostic::error(
            format!(
              "Variable {} is both exported and unexported",
              unexport.name.value
            ),
            unexport.range,
          ));
        }
      }

      diagnostics
    }
  }
}
