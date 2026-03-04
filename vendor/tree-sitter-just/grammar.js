/**
 * @file Justfile grammar for tree-sitter
 * @author Anshuman Medhi <amedhi@connect.ust.uk>
 * @author Trevor Gross <tmgross@umich.edu>
 * @author Amaan Qureshi <amaanq12@gmail.com>
 * @license Apache-2.0
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

const ESCAPE_SEQUENCE = token(/\\([nrt"\\]|(\r?\n))/);
// Flags to `/usr/bin/env`, anything that starts with a dash
const SHEBANG_ENV_FLAG = token(/-\S*/);

// All keywords in just are soft: they can be used as variable names, recipe
// names, parameter names, etc.  The parser disambiguates via grammar structure
// (what follows the token), not by reserving keywords.
//
// We split them into two groups for the `keyword_identifier` rule:
//
// - ITEM_KEYWORDS start top-level items and create GLR conflicts with
//   assignment/recipe when used as names.
// - EXPR_KEYWORDS only appear inside expressions; at top level they are
//   unambiguously names (no keyword-starting rule competes).
//
// Both groups are included in `keyword_identifier` so that any keyword can
// appear wherever an identifier (NAME) is expected.
const ITEM_KEYWORDS = [
  "alias",
  "export",
  "import",
  "mod",
  "set",
  "unexport",
];

const EXPR_KEYWORDS = [
  "assert",
  "else",
  "env",
  "false",
  "if",
  "shell",
  "true",
];

const ALL_KEYWORDS = [...ITEM_KEYWORDS, ...EXPR_KEYWORDS];

/**
 * Creates a rule to match one or more of the rules separated by a comma
 *
 * @param {RuleOrLiteral} rule
 *
 * @return {SeqRule}
 */
function comma_sep1(rule) {
  return seq(rule, repeat(seq(",", rule)));
}

/**
 * Creates a rule to match an array-like structure filled with `item`
 *
 * @param {RuleOrLiteral} rule
 *
 * @return {Rule}
 */
function array(rule) {
  const item = field("element", rule);
  return field(
    "array",
    seq(
      "[",
      optional(field("content", seq(comma_sep1(item), optional(item)))),
      "]",
    ),
  );
}

/**
 * Matches an identifier in a NAME position.  Includes `keyword_identifier`
 * so that soft keywords (`export`, `set`, `mod`, …) can appear as names.
 * The alias ensures `keyword_identifier` appears as plain `identifier` in
 * the parse tree, so LSP code doesn't need to special-case it.
 *
 * @param {GrammarSymbols<string>} $
 * @return {ChoiceRule}
 */
function name($) {
  return choice($.identifier, alias($.keyword_identifier, $.identifier));
}

module.exports = grammar({
  name: "just",

  externals: ($) => [
    $._indent,
    $._dedent,
    $._newline,
    $.text,
    $.error_recovery,
  ],

  // Allow comments, backslash-escaped newlines (with optional trailing whitespace),
  // and whitespace anywhere
  extras: ($) => [$.comment, /\\(\n|\r\n)\s*/, /\s/],

  inline: ($) => [
    $._string,
    $._string_indented,
    $._raw_string_indented,
    $._expression_recurse,
  ],

  word: ($) => $.identifier,

  // GLR conflicts: when a keyword appears at the start of a line, the parser
  // forks — one branch tries the keyword-specific rule (e.g. $.unexport),
  // the other treats it as a name in $.assignment or $.recipe_header.
  // The ambiguity resolves as soon as the next token(s) are seen.
  conflicts: ($) => [
    // keyword_identifier conflicts: when a keyword appears after another
    // keyword token (e.g. `alias alias := ...`), the parser must decide
    // whether to commit it as keyword_identifier (name within the rule)
    // or as a new top-level keyword.
    [$.keyword_identifier, $.alias],
    [$.keyword_identifier, $.export],
    [$.keyword_identifier, $.unexport],
    [$.keyword_identifier, $.import],
    [$.keyword_identifier, $.module],
    [$.keyword_identifier, $.setting],
    // Expression-keyword conflicts: `assert` could be keyword_identifier
    // (as a name) or start of assert_expression; similarly for if.
    [$.keyword_identifier, $.assert_expression],
    [$.keyword_identifier, $.if_expression],
    // if-expression dangling-else: `else` after braced_expr could be
    // else_clause, else_if_clause, or end of the if_expression.
    [$.if_expression],
  ],

  rules: {
    // justfile      : item* EOF
    source_file: ($) =>
      seq(optional(seq($.shebang, $._newline)), repeat($._item)),

    // item          : recipe
    //               | alias
    //               | assignment
    //               | export
    //               | unexport
    //               | import
    //               | module
    //               | setting
    _item: ($) =>
      choice(
        $.recipe,
        $.alias,
        $.assignment,
        $.export,
        $.unexport,
        $.import,
        $.module,
        $.setting,
      ),

    // keyword_identifier: allows any keyword to appear where NAME is expected.
    // Used via name($) which aliases this entire node to `identifier`, so
    // LSP code and queries see a uniform node type.
    keyword_identifier: (_) => choice(...ALL_KEYWORDS),

    // alias         : 'alias' NAME ':=' target eol
    // target        : NAME ('::' NAME)*
    // Dynamic precedence: prefer `alias NAME := target` over a recipe named
    // "alias" when both parses are valid.
    alias: ($) =>
      prec.dynamic(1, seq(
        repeat($.attribute),
        "alias",
        field("left", name($)),
        ":=",
        field("right", choice($.module_path, name($))),
      )),

    // module_path   : NAME '::' NAME ('::' NAME)*
    module_path: ($) =>
      seq(name($), repeat1(seq("::", name($)))),

    // assignment    : attribute* NAME ':=' expression eol
    assignment: ($) =>
      seq(
        repeat($.attribute),
        field("left", name($)),
        ":=",
        field("right", $.expression),
        $._newline,
      ),

    // export        : attribute* 'export' assignment
    export: ($) => prec.dynamic(1, seq(repeat($.attribute), "export", $.assignment)),

    // unexport      : 'unexport' NAME eol
    unexport: ($) => prec.dynamic(1, seq("unexport", field("name", name($)), $._newline)),

    // import        : 'import' '?'? string? eol
    import: ($) => prec.dynamic(1, seq("import", optional("?"), optional($.string))),

    // module        : attribute* 'mod' '?'? NAME string? eol
    module: ($) =>
      prec.dynamic(1, seq(
        repeat($.attribute),
        "mod",
        optional("?"),
        field("name", name($)),
        optional($.string),
      )),

    // setting       : 'set' NAME (':=' (boolean | string | string_list))? eol
    //               | 'set' 'shell' ':=' string_list eol
    //
    // Dynamic precedence ensures `set NAME` is preferred as a setting over
    // a recipe named "set" with NAME as a parameter.
    setting: ($) =>
      prec.dynamic(1, choice(
        seq(
          "set",
          field("left", name($)),
          field(
            "right",
            optional(seq(":=", choice($.boolean, $.string, array($.string)))),
          ),
          $._newline,
        ),
        seq("set", "shell", ":=", field("right", array($.string)), $._newline),
      )),

    // boolean       : ':=' ('true' | 'false')
    boolean: (_) => choice("true", "false"),

    // expression    : disjunct '||' expression
    //               | disjunct
    // disjunct      : conjunct '&&' disjunct
    //               | conjunct
    // conjunct      : 'if' condition '{' expression '}' 'else' '{' expression '}'
    //               | 'assert' '(' condition ',' expression ')'
    //               | '/' expression
    //               | value '/' expression
    //               | value '+' expression
    //               | value
    expression: ($) => seq(optional("/"), $._expression_inner),

    _expression_inner: ($) =>
      choice(
        $.if_expression,
        $.assert_expression,
        prec.left(4, seq($._expression_recurse, "||", $._expression_recurse)),
        prec.left(3, seq($._expression_recurse, "&&", $._expression_recurse)),
        prec.left(2, seq($._expression_recurse, "+", $._expression_recurse)),
        prec.left(1, seq($._expression_recurse, "/", $._expression_recurse)),
        $.value,
      ),

    // We can't mark `_expression_inner` inline because it causes an infinite
    // loop at generation, so we just alias it.
    _expression_recurse: ($) => alias($._expression_inner, "expression"),

    if_expression: ($) =>
      seq(
        "if",
        $.condition,
        field("consequence", $._braced_expr),
        repeat(field("alternative", $.else_if_clause)),
        optional(field("alternative", $.else_clause)),
      ),

    assert_expression: ($) =>
      seq(
        "assert",
        "(",
        field("condition", $.condition),
        ",",
        field("message", $.expression),
        ")",
      ),

    else_if_clause: ($) => seq("else", "if", $.condition, $._braced_expr),

    else_clause: ($) => seq("else", $._braced_expr),

    _braced_expr: ($) => seq("{", field("body", $.expression), "}"),

    // condition     : expression '==' expression
    //               | expression '!=' expression
    //               | expression '=~' expression
    condition: ($) =>
      choice(
        seq($.expression, "==", $.expression),
        seq($.expression, "!=", $.expression),
        seq($.expression, "=~", choice($.regex_literal, $.expression)),
        // verify whether this is valid
        $.expression,
      ),

    // Capture this special for injections
    regex_literal: ($) => prec(1, $.string),

    // value         : NAME '(' sequence? ')'
    //               | BACKTICK
    //               | INDENTED_BACKTICK
    //               | NAME
    //               | string
    //               | '(' expression ')'
    value: ($) =>
      prec.left(
        choice(
          $.function_call,
          $.external_command,
          name($),
          $.string,
          $.numeric_error,
          seq("(", $.expression, ")"),
        ),
      ),

    function_call: ($) =>
      seq(
        field("name", name($)),
        "(",
        optional(field("arguments", $.sequence)),
        ")",
      ),

    external_command: ($) =>
      choice(seq($._backticked), seq($._indented_backticked)),

    // sequence      : expression ',' sequence
    //               | expression ','?
    sequence: ($) => comma_sep1($.expression),

    attribute: ($) =>
      seq(
        "[",
        comma_sep1(
          choice(
            name($),
            seq(
              name($),
              "(",
              field("argument", comma_sep1(choice(
                $.string,
                $.attribute_named_param,
              ))),
              ")",
            ),
            seq(name($), ":", field("argument", $.string)),
          ),
        ),
        "]",
        $._newline,
      ),

    // Named parameter in attribute: key='value' or just key (flag)
    attribute_named_param: ($) =>
      seq(
        field("name", name($)),
        optional(seq("=", field("value", $.string))),
      ),

    // A complete recipe
    // recipe        : attributes* '@'? NAME parameter* variadic? ':' dependencies eol body?
    recipe: ($) =>
      seq(
        repeat($.attribute),
        $.recipe_header,
        $._newline,
        optional($.recipe_body),
      ),

    recipe_header: ($) =>
      seq(
        optional("@"),
        field("name", name($)),
        optional($.parameters),
        ":",
        optional($.dependencies),
      ),

    parameters: ($) =>
      seq(repeat($.parameter), choice($.parameter, $.variadic_parameter)),

    // parameter     : '$'? NAME
    //               | '$'? NAME '=' value
    parameter: ($) =>
      seq(
        optional("$"),
        field("name", name($)),
        optional(seq("=", field("default", $.value))),
      ),

    // variadic      : '*' parameter
    //               | '+' parameter
    variadic_parameter: ($) =>
      seq(field("kleene", choice("*", "+")), $.parameter),

    dependencies: ($) => repeat1(seq(optional("&&"), $.dependency)),

    // dependency    : target
    //               | '(' target expression* ')'
    // target        : NAME ('::' NAME)*
    dependency: ($) =>
      choice(
        field("name", $.module_path),
        field("name", name($)),
        $.dependency_expression,
      ),

    // contents of `(recipe expression)`
    dependency_expression: ($) =>
      seq(
        "(",
        field("name", choice($.module_path, name($))),
        repeat($.expression),
        ")",
      ),

    // body          : INDENT line+ DEDENT
    recipe_body: ($) =>
      seq(
        $._indent,
        optional(seq(field("shebang", $.shebang), $._newline)),
        repeat(choice(seq($.recipe_line, $._newline), $._newline)),
        $._dedent,
      ),

    recipe_line: ($) =>
      seq(
        optional($.recipe_line_prefix),
        repeat1(choice($.text, $.interpolation)),
      ),

    recipe_line_prefix: (_) => choice("@-", "-@", "@", "-"),

    // Any shebang. Needs a named field to apply injection queries correctly.
    shebang: ($) =>
      seq(/#![ \t]*/, choice($._shebang_with_lang, $._opaque_shebang)),

    // Shebang with a nested `language` token that we can extract
    _shebang_with_lang: ($) =>
      seq(
        /\S*\//,
        optional(seq("env", repeat(SHEBANG_ENV_FLAG))),
        alias($.identifier, $.language),
        /.*/,
      ),

    // Fallback shebang, any string
    _opaque_shebang: (_) => /[^/\n]+/,

    // string        : 'x'? STRING
    //               | 'x'? INDENTED_STRING
    //               | 'x'? RAW_STRING
    //               | 'x'? INDENTED_RAW_STRING
    string: ($) =>
      choice(
        $._string_indented,
        $._raw_string_indented,
        $._string,
        // _raw_string, can't be written as a separate inline for osm reason
        /'[^']*'/,
        // executable string variants (x prefix)
        seq("x", $._string_indented),
        seq("x", $._raw_string_indented),
        seq("x", $._string),
        seq("x", /'[^']*'/),
      ),

    _raw_string_indented: (_) => seq("'''", repeat(/./), "'''"),
    _string: ($) => seq('"', repeat(choice($.escape_sequence, /[^\\"]+/)), '"'),
    // We need try two separate munches so neither escape sequences nor
    // potential closing quotes get eaten.
    _string_indented: ($) =>
      seq('"""', repeat(choice($.escape_sequence, /[^\\]?[^\\"]+/)), '"""'),

    escape_sequence: (_) => ESCAPE_SEQUENCE,

    _backticked: ($) => seq("`", optional($.command_body), "`"),
    _indented_backticked: ($) => seq("```", optional($.command_body), "```"),

    command_body: ($) => repeat1(choice($.interpolation, /./)),

    // interpolation : '{{' expression '}}'
    interpolation: ($) => seq("{{", $.expression, "}}"),

    identifier: (_) => /[a-zA-Z_][a-zA-Z0-9_-]*/,

    // Numbers aren't allowed as values, but we capture them anyway as errors so
    // they don't mess up the whole syntax
    numeric_error: (_) => /(\d+\.\d*|\d+)/,

    // `# ...` comment
    comment: (_) => token(prec(-1, /#.*/)),
  },
});
