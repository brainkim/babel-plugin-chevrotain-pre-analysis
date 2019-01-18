import requireFromString from "require-from-string";
import { declare } from "@babel/helper-plugin-utils";

const PARSERS_EXPORT_NAME = "_______PARSERS_______";
const plugin = declare((babel) => {
  const { types: t, transformFromAstSync, traverse } = babel;
  const identifyParserImportsVisitor = {
    ImportDeclaration(path) {
      if (
        path.scope.parent == null &&
        path.node.source.value === "chevrotain"
      ) {
        const parserClassNames = path.node.specifiers
          .map((specifier) => {
            if (
              t.isImportSpecifier(specifier) &&
              specifier.imported.name === "Parser"
            ) {
              return specifier.local.name;
            } else if (t.isImportNamespaceSpecifier(specifier)) {
              return specifier.local.name + ".Parser";
            } else if (t.isImportDefaultSpecifier(specifier)) {
              return specifier.local.name + ".Parser";
            }
          })
          .filter((name) => name);
        this.addParserClassNames(parserClassNames);
      }
    },
    CallExpression(path) {
      if (
        path.scope.parent == null &&
        path.node.callee.name === "require" &&
        path.node.arguments[0] &&
        path.node.arguments[0].value === "chevrotain"
      ) {
        const parent = path.parent;
        if (t.isIdentifier(parent.id)) {
          this.addParserClassNames([parent.id.name + ".Parser"]);
        } else if (t.isObjectPattern(parent.id)) {
          const parserClassNames = parent.id.properties
            .filter((property) => property.key.name === "Parser")
            .map((property) => property.value.name);
          this.addParserClassNames(parserClassNames);
        }
      }
    },
  };

  const identifyParserClassInherits = {
    Class(path) {
      if (inheritsFromClassNames(path.node, this.parserClassNames)) {
        this.setParserClassUseFlag();
        return;
      }
    },
  };

  function inheritsFromClassNames(node, classNames) {
    const superClass = node.superClass;
    if (t.isIdentifier(superClass)) {
      return classNames.includes(superClass.name);
    } else if (t.isMemberExpression(superClass)) {
      const name = superClass.object.name + "." + superClass.property.name;
      return classNames.includes(name);
    }
    return false;
  }

  const exportParsersVisitor = {
    Program(path) {
      path.node.body.unshift(
        t.expressionStatement(
          t.assignmentExpression(
            "=",
            t.memberExpression(
              t.identifier("exports"),
              t.identifier(PARSERS_EXPORT_NAME),
            ),
            t.objectExpression([]),
          ),
        ),
      );
    },
    Class(path) {
      if (!inheritsFromClassNames(path.node, this.parserClassNames)) {
        return;
      }
      const className = path.node.id.name;
      path.insertAfter(
        t.assignmentExpression(
          "=",
          t.memberExpression(
            t.memberExpression(
              t.identifier("exports"),
              t.identifier(PARSERS_EXPORT_NAME),
            ),
            t.identifier(className),
          ),
          t.identifier(className),
        ),
      );
    },
  };

  const insertSerializedGrammarVisitor = {
    Class(path) {
      if (!inheritsFromClassNames(path.node, this.parserClassNames)) {
        return;
      }
      const className = path.node.id.name;
      const constructorMethod = path.node.body.body.find(
        (node) => t.isClassMethod(node) && node.key.name === "constructor",
      );
      if (!constructorMethod) {
        return;
      }
      const superExpressionStatement = constructorMethod.body.body.find(
        (node) =>
          t.isExpressionStatement(node) &&
          t.isCallExpression(node.expression) &&
          t.isSuper(node.expression.callee),
      );
      if (!superExpressionStatement) {
        return;
      }
      const grammar = this.serializedGrammars[className];
      const config = superExpressionStatement.expression.arguments[1];
      const serializedGrammarProperty = t.objectProperty(
        t.identifier("serializedGrammar"),
        t.callExpression(
          t.memberExpression(t.identifier("JSON"), t.identifier("parse")),
          [t.stringLiteral(JSON.stringify(grammar))],
        ),
      );
      if (!config) {
        superExpressionStatement.expression.arguments.push(
          t.objectExpression([serializedGrammarProperty]),
        );
      } else if (t.isObjectExpression(config)) {
        config.properties.push(serializedGrammarProperty);
      }
    },
  };

  return {
    visitor: {
      Program(path, state) {
        function isDebug() {
          return state.opts.options && !!state.opts.options.debug;
        }

        // NOTE: we need a `generated` flag check here b/c in babel v7.0.0-rc the Program visitor will be called when transformFromAstSync is called, throwing the compiler into an infinite loop. 🙄 Thanks babel.
        if (path.parent.generated) {
          return;
        }

        // Get any chevrotain.Parser class imports or requires
        const parserClassNames = [];
        path.traverse(identifyParserImportsVisitor, {
          addParserClassNames(names) {
            parserClassNames.push(...names);
          },
        });
        if (!parserClassNames.length) {
          return;
        }
        if (isDebug()) {
          console.log(
            state.file.opts.filename,
            "imports chevrotain via",
            parserClassNames,
          );
        }

        // See if anything inherits from the chevrotain.Parser class names
        let hasParserClasses = false;
        path.traverse(identifyParserClassInherits, {
          setParserClassUseFlag() {
            hasParserClasses = true;
          },
          parserClassNames: parserClassNames,
        });
        if (!hasParserClasses) {
          if (isDebug()) {
            console.log("   --- No Parser class inheritence, skipping");
          }
          return;
        }

        const fileWithExportedParsers = t.cloneNode(path.parent);
        fileWithExportedParsers.generated = true;
        traverse(
          fileWithExportedParsers,
          exportParsersVisitor,
          path.scope,
          { parserClassNames },
          path,
        );
        const { code } = transformFromAstSync(
          fileWithExportedParsers,
          null,
          state.file.opts,
        );
        const { [PARSERS_EXPORT_NAME]: parsers } = requireFromString(
          String(code),
          state.file.opts.filename,
        );
        if (!parsers) {
          if (isDebug()) {
            console.log("   --- No parsers found");
          }
          return;
        }

        const serializedGrammars = Object.keys(parsers).reduce(
          (serializedGrammars, key) => {
            if (isDebug()) {
              console.log(
                "   --- Adding serialized grammar to Parser class",
                key,
              );
            }

            const parser = new parsers[key]([]);
            const grammar = parser.getSerializedGastProductions();
            return {
              ...serializedGrammars,
              [key]: grammar,
            };
          },
          {},
        );
        path.traverse(insertSerializedGrammarVisitor, {
          serializedGrammars,
          parserClassNames,
        });
      },
    },
  };
});

export default plugin;
