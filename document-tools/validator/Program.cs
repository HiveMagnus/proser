using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

if (args.Length == 0) { Console.Error.WriteLine("Supply fixture DOCX paths."); return 2; }
var failed = false;
foreach (var path in args)
{
    try
    {
        using var package = WordprocessingDocument.Open(path, false);
        var validator = new OpenXmlValidator(FileFormatVersions.Office2019) { MaxNumberOfErrors = 100 };
        var errors = validator.Validate(package).Select(error => new { error.Id, error.Description, Part = error.Part?.Uri.ToString(), Path = error.Path?.XPath }).ToArray();
        Console.WriteLine(JsonSerializer.Serialize(new { file = Path.GetFileName(path), passed = errors.Length == 0, errors }));
        failed |= errors.Length != 0;
    }
    catch (Exception error)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { file = Path.GetFileName(path), passed = false, error = error.Message }));
        failed = true;
    }
}
return failed ? 1 : 0;
