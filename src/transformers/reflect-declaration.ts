import * as ts from 'typescript';

export const DECORATOR_NAME_PREFIX = 'Φnt:method:';

export default function transformer(program: ts.Program): ts.TransformerFactory<ts.SourceFile> {
    const checker = program.getTypeChecker();

    return () => {
        return (sourceFile: ts.SourceFile): ts.SourceFile => {
            const newStatements: ts.Statement[] = [];

            const visitNode = (node: ts.Node) => {
                if (ts.isClassDeclaration(node) && node.name) {
                    const className = node.name.text;

                    for (const member of node.members) {
                        if (!ts.isPropertyDeclaration(member) || !member.name) continue;
                        if (!ts.isIdentifier(member.name)) continue;

                        const propName = member.name.text;
                        const symbol = checker.getSymbolAtLocation(member.name);

                        if (!symbol) continue;

                        const type = checker.getTypeOfSymbolAtLocation(symbol, member);
                        const callSignatures = type.getCallSignatures();

                        if (callSignatures.length === 0) continue;

                        const returnType = callSignatures[0].getReturnType();
                        let actualType = returnType;

                        if (returnType.symbol?.getName() === 'Promise') {
                            const typeArgs = (returnType as ts.TypeReference).typeArguments;
                            if (typeArgs && typeArgs.length > 0) {
                                actualType = typeArgs[0];
                            }
                        }

                        const actualTypeStr = checker.typeToString(
                            actualType,
                            undefined,
                            ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType,
                        );
                        if (!actualTypeStr || actualTypeStr === 'void' || actualTypeStr === 'any') continue;

                        newStatements.push(
                            ts.factory.createExpressionStatement(
                                ts.factory.createCallExpression(
                                    ts.factory.createIdentifier('Reflect.defineMetadata'),
                                    undefined,
                                    [
                                        ts.factory.createStringLiteral(`${DECORATOR_NAME_PREFIX}${propName}`),
                                        ts.factory.createStringLiteral(actualTypeStr),
                                        ts.factory.createPropertyAccessExpression(
                                            ts.factory.createIdentifier(className),
                                            ts.factory.createIdentifier('prototype'),
                                        ),
                                    ],
                                ),
                            ),
                        );
                    }
                }

                ts.forEachChild(node, visitNode);
            };

            ts.forEachChild(sourceFile, visitNode);

            return ts.factory.updateSourceFile(sourceFile, [...sourceFile.statements, ...newStatements]);
        };
    };
}
