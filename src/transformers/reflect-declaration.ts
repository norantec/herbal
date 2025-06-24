import * as ts from 'typescript';
import { Project, CompilerOptions, SourceFile, Signature } from 'ts-morph';
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';

export const DECORATOR_NAME_PREFIX = 'Φnt:method:';

export default function transformer(program: ts.Program): ts.TransformerFactory<ts.SourceFile> {
    const project = new Project({
        compilerOptions: program.getCompilerOptions() as CompilerOptions,
    });

    return () => {
        return (sourceFile) => {
            const filePath = sourceFile.fileName;
            const patchSourceFile = project.addSourceFileAtPathIfExists(filePath);

            if (!(patchSourceFile instanceof SourceFile)) return sourceFile;

            const statements: ts.Statement[] = [];

            for (const cls of patchSourceFile.getClasses()) {
                const className = cls.getName();

                if (StringUtil.isFalsyString(className)) continue;

                for (const prop of cls.getProperties()) {
                    const name = prop.getName();
                    const type = prop.getType();

                    const callSignature = type.getCallSignatures()[0];
                    if (!(callSignature instanceof Signature)) continue;

                    const returnType = callSignature.getReturnType();
                    let actualReturn = returnType;

                    if (returnType.getSymbol()?.getName?.() === 'Promise') {
                        const args = returnType.getTypeArguments();
                        if (args.length > 0) {
                            actualReturn = args[0];
                        }
                    }

                    const typeStr = actualReturn.getText();

                    if (StringUtil.isFalsyString(typeStr)) continue;

                    statements.push(
                        ts.factory.createExpressionStatement(
                            ts.factory.createCallExpression(
                                ts.factory.createIdentifier('Reflect.defineMetadata'),
                                undefined,
                                [
                                    ts.factory.createStringLiteral(`${DECORATOR_NAME_PREFIX}${name}`),
                                    ts.factory.createStringLiteral(typeStr),
                                    ts.factory.createPropertyAccessExpression(
                                        ts.factory.createIdentifier(className!),
                                        ts.factory.createIdentifier('prototype'),
                                    ),
                                ],
                            ),
                        ),
                    );
                }
            }

            return ts.factory.updateSourceFile(sourceFile, [...sourceFile.statements, ...statements]);
        };
    };
}
